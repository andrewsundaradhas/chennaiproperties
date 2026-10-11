// Channel-agnostic conversation orchestration. Web chat (and the future WhatsApp adapter) call
// handleCustomerMessage; nothing here knows which channel a message came from.
//
// Flow: persist inbound → model INTERPRETS (schema-validated plan, no facts) → backend runs
// deterministic tools → grounded draft reply → optional model rephrase, checked by the guard →
// persist outbound.
import type { Db, Queryable } from '../db/client.js';
import { AiError, type AiProvider } from '../ai/provider.js';
import { checkGrounded } from '../ai/guard.js';
import type { Interpretation, PropertyRef, QuestionField } from '../ai/schemas.js';
import { InterpretationSchema } from '../ai/schemas.js';
import { detectLanguage } from '../ai/rules.js';
import { toCardItem, type Card, type PropertyCardItem } from '../domain/cards.js';
import { formatInr, formatInrCompact, formatPrice, humanise } from '../domain/format.js';
import type { Property } from '../domain/property.js';
import {
  hasSearchableRequirements,
  mergeRequirements,
  type RequirementsPatch,
  type Requirements,
} from '../domain/requirements.js';
import { logger } from '../lib/logger.js';
import {
  conversationsRepo,
  customersRepo,
  faqRepo,
  messagesRepo,
  requirementsRepo,
  shortlistsRepo,
  type Conversation,
  type Message,
} from '../repositories/conversations.repo.js';
import { propertiesRepo } from '../repositories/properties.repo.js';
import { createLead } from './lead.service.js';
import { describeFilters, searchProperties, type RankedProperty } from './search.service.js';

export interface ConversationDeps {
  db: Db;
  ai: AiProvider;
  /** Deterministic interpreter used if the primary provider fails. */
  fallback: AiProvider;
  composeTimeoutMs?: number;
  /** When the model may rephrase the grounded draft. Default: only for non-English messages. */
  composeFor?: 'non_english' | 'always' | 'never';
  interpretTimeoutMs?: number;
}

export interface HandleResult {
  inbound: Message;
  reply: Message;
  duplicate: boolean;
}

interface Outcome {
  draft: string;
  cards: Card[];
  /** Grounded data the rephrase step may use. */
  facts: Record<string, unknown>;
  /** Set when the turn could not be completed and the customer should retry. */
  retryable?: boolean;
}

const RETRY_MESSAGE =
  "Sorry — I couldn't process that just now. Your message is saved; please try again in a moment.";

export async function handleCustomerMessage(
  deps: ConversationDeps,
  conversation: Conversation,
  text: string,
  opts: { clientMessageId?: string; requestId?: string } = {},
): Promise<HandleResult> {
  const { db } = deps;
  const started = Date.now();

  // 1. Idempotency: a repeated client message id returns the original reply.
  let inbound: Message | null = null;
  if (opts.clientMessageId) {
    inbound = await messagesRepo.findByProviderId(db, conversation.id, opts.clientMessageId);
    if (inbound) {
      const existingReply = await messagesRepo.findReplyTo(db, conversation.id, inbound.id);
      if (existingReply) return { inbound, reply: existingReply, duplicate: true };
    }
  }

  // 2. Persist the customer's message BEFORE calling the AI so a failure never loses it.
  inbound ??=
    (await messagesRepo.insert(db, {
      conversation_id: conversation.id,
      direction: 'inbound',
      body: text,
      provider_message_id: opts.clientMessageId ?? null,
    })) ?? (await messagesRepo.findByProviderId(db, conversation.id, opts.clientMessageId!))!;
  await conversationsRepo.touch(db, conversation.id);

  // 3. Context for interpretation.
  const { requirements, confidence } = await requirementsRepo.get(db, conversation.id);
  const lastResults = await propertiesRepo.getManyByIds(db, conversation.last_result_ids);
  const history = (await messagesRepo.list(db, conversation.id, 13))
    .filter((m) => m.id !== inbound!.id && m.message_type === 'text')
    .map((m) => ({ role: m.direction === 'inbound' ? ('customer' as const) : ('assistant' as const), text: m.body }));
  const faqKeys = await faqRepo.keys(db);
  const interpretInput = {
    message: text,
    history,
    requirements,
    lastResults: lastResults.map((p, i) => ({ index: i + 1, listing_code: p.listing_code, title: p.title })),
    faqKeys,
  };

  // 4. Interpret (primary provider, then deterministic fallback).
  let interp: Interpretation | null = null;
  let usedFallback = false;
  let aiErrorCategory: string | undefined;
  try {
    interp = InterpretationSchema.parse(
      await withTimeout(deps.ai.interpret(interpretInput), deps.interpretTimeoutMs ?? 45000),
    );
  } catch (err) {
    aiErrorCategory = err instanceof AiError ? err.category : 'invalid_output';
    logger.warn('ai.interpret_failed', { requestId: opts.requestId, provider: deps.ai.name, category: aiErrorCategory });
    if (deps.fallback !== deps.ai) {
      try {
        const fb = await deps.fallback.interpret(interpretInput);
        if (fb.intent !== 'unclear') {
          interp = fb;
          usedFallback = true;
        }
      } catch {
        // fall through to the retry message
      }
    }
  }

  // Models sometimes label Tanglish as English; the deterministic detector backs that up.
  if (interp && interp.language === 'en') interp = { ...interp, language: detectLanguage(text) };

  // 5. Execute tools deterministically.
  let outcome: Outcome;
  if (!interp) {
    outcome = { draft: RETRY_MESSAGE, cards: [], facts: {}, retryable: true };
  } else {
    try {
      outcome = await execute(db, { conversation, interp, requirements, confidence, lastResults });
    } catch (err) {
      logger.error('chat.execute_failed', { requestId: opts.requestId, message: (err as Error).message });
      outcome = { draft: RETRY_MESSAGE, cards: [], facts: {}, retryable: true };
    }
  }

  // 6. Optional natural-language rephrase, accepted only if it stays grounded.
  let body = outcome.draft;
  let composed = false;
  const composeFor = deps.composeFor ?? 'non_english';
  const wantsCompose = composeFor === 'always' || (composeFor === 'non_english' && interp?.language !== 'en');
  if (interp && deps.ai.compose && wantsCompose && !usedFallback && !outcome.retryable) {
    try {
      const rewrite = await withTimeout(
        deps.ai.compose({ message: text, language: interp.language, draft: outcome.draft, facts: outcome.facts }),
        deps.composeTimeoutMs ?? 20000,
      );
      const check = checkGrounded(outcome.draft, rewrite);
      if (check.ok) {
        body = rewrite;
        composed = true;
      } else logger.warn('ai.compose_rejected', { requestId: opts.requestId, reason: check.reason });
    } catch (err) {
      logger.warn('ai.compose_failed', { requestId: opts.requestId, category: err instanceof AiError ? err.category : 'unknown' });
    }
  }

  // 7. Persist the reply.
  const reply = (await messagesRepo.insert(db, {
    conversation_id: conversation.id,
    direction: 'outbound',
    body,
    metadata: {
      reply_to: inbound.id,
      intent: interp?.intent ?? null,
      cards: outcome.cards,
      retryable: outcome.retryable ?? false,
      ai: { provider: usedFallback ? deps.fallback.name : deps.ai.name, fallback: usedFallback, composed, error: aiErrorCategory ?? null },
      duration_ms: Date.now() - started,
      request_id: opts.requestId ?? null,
    },
  }))!;
  await conversationsRepo.touch(db, conversation.id);
  if (interp && interp.language !== 'en') {
    await customersRepo.updateContact(db, conversation.customer_id, { preferred_language: interp.language });
  }
  logger.info('chat.turn', {
    requestId: opts.requestId,
    intent: interp?.intent ?? null,
    provider: deps.ai.name,
    fallback: usedFallback,
    composed,
    duration_ms: Date.now() - started,
  });
  return { inbound, reply, duplicate: false };
}

// ---------------------------------------------------------------------------------------------

interface ExecContext {
  conversation: Conversation;
  interp: Interpretation;
  requirements: Requirements;
  confidence: Awaited<ReturnType<typeof requirementsRepo.get>>['confidence'];
  lastResults: Property[];
}

async function execute(q: Queryable, ctx: ExecContext): Promise<Outcome> {
  switch (ctx.interp.intent) {
    case 'search':
    case 'refine':
      return runSearch(q, ctx);
    case 'show_more':
      return showMore(q, ctx);
    case 'property_question':
      return answerPropertyQuestion(q, ctx);
    case 'compare':
      return compare(q, ctx);
    case 'shortlist':
      return shortlist(q, ctx);
    case 'callback':
    case 'site_visit':
      return enquiry(q, ctx);
    case 'provide_contact':
      return provideContact(q, ctx);
    case 'faq':
      return faq(q, ctx);
    case 'greeting':
      return {
        draft:
          "Hello! I can help you find a home to rent or buy in Chennai. Tell me the area, budget and BHK you're after — for example \"2BHK for rent in Velachery under ₹25,000\". (Note: the listings in this prototype are sample demo data.)",
        cards: [examplesCard()],
        facts: {},
      };
    case 'unclear':
    default:
      return {
        draft:
          "Sorry, I didn't quite follow. Could you tell me whether you want to rent or buy, and the area, budget and number of bedrooms?",
        cards: [examplesCard()],
        facts: {},
      };
  }
}

function examplesCard(): Card {
  return {
    type: 'quick_replies',
    options: [
      { label: '2BHK to rent in Velachery', message: 'I need a 2BHK for rent in Velachery under ₹25,000' },
      { label: 'Buy in OMR', message: 'I want to buy a 2BHK on OMR under 70 lakh' },
      { label: 'Pet-friendly rentals', message: 'Pet-friendly house for rent in Anna Nagar' },
    ],
  };
}

function budgetFmt(req: Requirements) {
  return req.transaction_type === 'sale' ? formatInrCompact : formatInr;
}

async function runSearch(q: Queryable, ctx: ExecContext): Promise<Outcome> {
  const patch: RequirementsPatch = structuredClone(ctx.interp.requirements);
  const prior = ctx.requirements;

  // "Show cheaper ones": lower the ceiling below the most expensive listing just shown.
  if (ctx.interp.relative_budget === 'cheaper') {
    const shownMax = Math.max(0, ...ctx.lastResults.map((p) => p.price_amount));
    const reference = shownMax || prior.budget_max;
    if (reference && patch.set.budget_max === undefined) {
      patch.set.budget_max = Math.max(1000, Math.floor((reference * 0.9) / 500) * 500);
      patch.confidence.budget_max = 'inferred';
    }
  } else if (ctx.interp.relative_budget === 'more_expensive' && prior.budget_max && patch.set.budget_max === undefined) {
    patch.set.budget_max = Math.round((prior.budget_max * 1.25) / 500) * 500;
    patch.confidence.budget_max = 'inferred';
  }

  const { requirements, confidence, changed } = mergeRequirements(prior, ctx.confidence, patch);
  await requirementsRepo.save(q, ctx.conversation.id, ctx.conversation.customer_id, requirements, confidence);
  const facts: Record<string, unknown> = { requirements: describeFilters(requirements), changed };

  const ack = acknowledgeChanges(prior, requirements, changed);

  if (!requirements.transaction_type) {
    return {
      draft: `${ack}Are you looking to rent or to buy?`,
      cards: [
        {
          type: 'quick_replies',
          options: [
            { label: 'Rent', message: 'I want to rent' },
            { label: 'Buy', message: 'I want to buy' },
          ],
        },
      ],
      facts,
    };
  }
  if (!hasSearchableRequirements(requirements)) {
    return {
      draft: `${ack}Got it — ${requirements.transaction_type === 'rent' ? 'renting' : 'buying'}. Which area are you interested in, and what's your budget and BHK?`,
      cards: [],
      facts,
    };
  }

  const result = await searchProperties(q, requirements);
  const filters = result.appliedFilters.join(', ');

  if (result.status === 'unknown_locality') {
    await conversationsRepo.setLastResults(q, ctx.conversation.id, []);
    return {
      draft: `${ack}I don't recognise "${result.unresolvedLocalities.join(', ')}" as a Chennai locality in my list. Could you name a nearby area (for example Velachery, Adyar, Anna Nagar or OMR)?`,
      cards: [],
      facts,
    };
  }

  if (result.results.length > 0) {
    const items = result.results.map((r, i) => rankedToCard(r, i + 1));
    await conversationsRepo.setLastResults(q, ctx.conversation.id, items.map((i) => i.id));
    const shown = items.length;
    const more = result.totalMatches > shown ? ` (top ${shown} of ${result.totalMatches} — say "show more" to see others)` : '';
    const pending = items.filter((i) => i.availability_status === 'pending_confirmation');
    const pendingNote = pending.length
      ? ` Note: ${pending.map((p) => p.listing_code).join(', ')} ${pending.length > 1 ? 'are' : 'is'} pending availability confirmation.`
      : '';
    const unresolved = result.unresolvedLocalities.length
      ? ` (I didn't recognise "${result.unresolvedLocalities.join(', ')}", so I left it out.)`
      : '';
    return {
      draft: `${ack}Here ${shown === 1 ? 'is 1 listing' : `are ${shown} listings`} ${filters}${more}:${pendingNote}${unresolved}\n${items
        .map((i) => `${i.index}. ${i.listing_code} — ${shortLine(i)}`)
        .join('\n')}\nAsk me about any of them (e.g. "does the 2nd one allow pets?"), or request a callback or site visit.`,
      cards: [{ type: 'properties', items, total_matches: result.totalMatches, applied_filters: result.appliedFilters, near_match: null }],
      facts: { ...facts, results: items.map(factOf) },
    };
  }

  if (result.nearMatch) {
    const items = result.nearMatch.results.map((r, i) => rankedToCard(r, i + 1));
    await conversationsRepo.setLastResults(q, ctx.conversation.id, items.map((i) => i.id));
    return {
      draft: `${ack}I couldn't find an exact match ${filters}. The closest stored ${items.length === 1 ? 'listing is' : 'listings are'} ${result.nearMatch.explanation}:\n${items
        .map((i) => `${i.index}. ${i.listing_code} — ${shortLine(i)}`)
        .join('\n')}`,
      cards: [
        {
          type: 'properties',
          items,
          total_matches: 0,
          applied_filters: result.appliedFilters,
          near_match: { explanation: result.nearMatch.explanation },
        },
        ...relaxationChips(requirements),
      ],
      facts: { ...facts, near_match: result.nearMatch.explanation, results: items.map(factOf) },
    };
  }

  await conversationsRepo.setLastResults(q, ctx.conversation.id, []);
  const suggestions = relaxationSuggestions(requirements);
  return {
    draft: `${ack}No stored listings match ${filters}. ${suggestions.length ? `You could try ${suggestions.join(' or ')}.` : 'Try a different area or budget.'}`,
    cards: relaxationChips(requirements),
    facts: { ...facts, results: [] },
  };
}

function acknowledgeChanges(prior: Requirements, next: Requirements, changed: string[]): string {
  const hadPrior = prior.transaction_type !== null || prior.locality_terms.length > 0 || prior.budget_max !== null;
  if (!hadPrior || changed.length === 0) return '';
  const parts: string[] = [];
  if (changed.includes('budget_max') && next.budget_max !== null) parts.push(`budget to under ${budgetFmt(next)(next.budget_max)}`);
  if (changed.includes('furnishing')) parts.push(next.furnishing ? `furnishing to ${humanise(next.furnishing)}` : 'removed the furnishing filter');
  if (changed.includes('locality_terms')) parts.push(next.locality_terms.length ? `area to ${next.locality_terms.join(' / ')}` : 'removed the area filter');
  if (changed.includes('bedrooms') && next.bedrooms !== null) parts.push(`${next.bedrooms}BHK`);
  if (changed.includes('transaction_type') && next.transaction_type) parts.push(next.transaction_type === 'rent' ? 'renting' : 'buying');
  if (parts.length === 0) return '';
  return `Updated: ${parts.join(', ')}. `;
}

function relaxationSuggestions(r: Requirements): string[] {
  const s: string[] = [];
  if (r.budget_max) s.push(`raising the budget to about ${budgetFmt(r)(Math.round((r.budget_max * 1.2) / 1000) * 1000)}`);
  if (r.furnishing) s.push('any furnishing');
  else if (r.bedrooms) s.push(`${r.bedrooms > 1 ? r.bedrooms - 1 : r.bedrooms + 1}BHK`);
  else if (r.locality_terms.length) s.push('a nearby area');
  return s.slice(0, 2);
}

function relaxationChips(r: Requirements): Card[] {
  const options: { label: string; message: string }[] = [];
  if (r.budget_max) {
    const raised = Math.round((r.budget_max * 1.2) / 1000) * 1000;
    const label = budgetFmt(r)(raised);
    options.push({ label: `Budget ${label}`, message: `Actually my budget is ${label}` });
  }
  if (r.furnishing) options.push({ label: 'Any furnishing', message: 'Any furnishing is fine' });
  if (r.bedrooms && r.bedrooms > 1) options.push({ label: `${r.bedrooms - 1}BHK`, message: `Show ${r.bedrooms - 1}BHK instead` });
  return options.length ? [{ type: 'quick_replies', options: options.slice(0, 3) }] : [];
}

async function showMore(q: Queryable, ctx: ExecContext): Promise<Outcome> {
  if (!ctx.requirements.transaction_type || !hasSearchableRequirements(ctx.requirements)) {
    return { draft: 'Tell me what you are looking for first — rent or buy, area, budget and BHK.', cards: [examplesCard()], facts: {} };
  }
  const result = await searchProperties(q, ctx.requirements, { limit: 10 });
  const shownIds = new Set(ctx.conversation.last_result_ids);
  const next = result.results.filter((r) => !shownIds.has(r.property.id)).slice(0, 5);
  if (next.length === 0) {
    return { draft: "That's all the matching listings I have right now. You could widen the area or budget to see more.", cards: relaxationChips(ctx.requirements), facts: {} };
  }
  const items = next.map((r, i) => rankedToCard(r, i + 1));
  await conversationsRepo.setLastResults(q, ctx.conversation.id, items.map((i) => i.id));
  return {
    draft: `Here are ${items.length} more ${result.appliedFilters.join(', ')}:\n${items.map((i) => `${i.index}. ${i.listing_code} — ${shortLine(i)}`).join('\n')}`,
    cards: [{ type: 'properties', items, total_matches: result.totalMatches, applied_filters: result.appliedFilters, near_match: null }],
    facts: { results: items.map(factOf) },
  };
}

async function resolveRefs(
  q: Queryable,
  ctx: ExecContext,
): Promise<{ properties: Property[]; problems: string[] }> {
  const properties: Property[] = [];
  const problems: string[] = [];
  const refs: PropertyRef[] = ctx.interp.property_refs;
  if (refs.length === 0 && ctx.lastResults.length === 1) return { properties: [ctx.lastResults[0]!], problems };
  for (const ref of refs) {
    let p: Property | null | undefined;
    if (ref.kind === 'index') {
      p = ctx.lastResults[ref.index - 1];
      if (!p) {
        problems.push(
          ctx.lastResults.length
            ? `There's no #${ref.index} in the current results — I showed ${ctx.lastResults.length}.`
            : `I haven't shown any results yet, so I can't tell which #${ref.index} you mean.`,
        );
      }
    } else if (ref.kind === 'last') {
      p = ctx.lastResults[ctx.lastResults.length - 1];
      if (!p) problems.push("I haven't shown any results yet.");
    } else {
      p = await propertiesRepo.getByCode(q, ref.code);
      if (!p || p.availability_status === 'deactivated') {
        problems.push(`I couldn't find an active listing with code ${ref.code.toUpperCase()}.`);
        p = null;
      }
    }
    if (p && !properties.some((x) => x.id === p!.id)) properties.push(p);
  }
  return { properties, problems };
}

async function answerPropertyQuestion(q: Queryable, ctx: ExecContext): Promise<Outcome> {
  const { properties, problems } = await resolveRefs(q, ctx);
  if (properties.length === 0) {
    return {
      draft: problems.length
        ? problems.join(' ')
        : 'Which listing do you mean? You can say "the second one" or use its code, like CP-DEMO-001.',
      cards: [],
      facts: {},
    };
  }
  // Re-read from the database so the answer reflects the latest stored state.
  const fresh = await propertiesRepo.getManyByIds(q, properties.slice(0, 2).map((p) => p.id));
  const fields = ctx.interp.question_fields.length ? ctx.interp.question_fields : (['description'] as QuestionField[]);
  const lines = fresh.map((p) => answerFields(p, fields, ctx.interp.amenity_asked));
  const cards: Card[] = fresh.map((p) => ({ type: 'property_detail', item: toCardItem(p, indexIn(ctx, p)) }));
  return {
    draft: [...problems, ...lines].join('\n\n'),
    cards,
    facts: { listings: fresh.map((p) => factOf(toCardItem(p, indexIn(ctx, p)))) },
  };
}

function indexIn(ctx: ExecContext, p: Property) {
  const i = ctx.lastResults.findIndex((x) => x.id === p.id);
  return i >= 0 ? i + 1 : 0;
}

const NOT_RECORDED = (what: string, code: string) =>
  `${what} isn't recorded for ${code}. I can ask the team to check — just request a callback.`;

export function answerFields(p: Property, fields: QuestionField[], amenityAsked: string | null): string {
  const code = p.listing_code;
  const out: string[] = [];
  for (const f of fields) {
    switch (f) {
      case 'pet_policy':
        out.push(
          p.pet_policy === 'unknown'
            ? NOT_RECORDED('The pet policy', code)
            : p.pet_policy === 'allowed'
              ? `${code}: pets are allowed, according to the listing record.`
              : p.pet_policy === 'not_allowed'
                ? `${code}: pets are not allowed, according to the listing record.`
                : `${code}: pets are considered case by case — the team would need to confirm.`,
        );
        break;
      case 'parking':
        out.push(
          p.parking === 'unknown'
            ? NOT_RECORDED('Parking', code)
            : `${code}: parking is ${p.parking === 'available' ? 'available' : 'not available'}, according to the listing record.`,
        );
        break;
      case 'furnishing':
        out.push(p.furnishing === 'unknown' ? NOT_RECORDED('Furnishing', code) : `${code} is ${humanise(p.furnishing)}.`);
        break;
      case 'price':
        out.push(`${code} is listed at ${formatPrice(p.price_amount, p.price_period)}.`);
        break;
      case 'availability':
        out.push(
          `${code} is currently marked "${humanise(p.availability_status)}" (record last updated ${p.updated_at.toISOString().slice(0, 10)}).${p.availability_status === 'pending_confirmation' ? ' That means it is not yet confirmed as available.' : ''}`,
        );
        break;
      case 'bedrooms':
        out.push(p.bedrooms === null ? NOT_RECORDED('The number of bedrooms', code) : `${code} has ${p.bedrooms} bedroom${p.bedrooms === 1 ? '' : 's'}.`);
        break;
      case 'bathrooms':
        out.push(p.bathrooms === null ? NOT_RECORDED('The number of bathrooms', code) : `${code} has ${p.bathrooms} bathroom${p.bathrooms === 1 ? '' : 's'}.`);
        break;
      case 'area':
        out.push(p.area_sqft === null ? NOT_RECORDED('The area', code) : `${code} is about ${p.area_sqft.toLocaleString('en-IN')} sq.ft.`);
        break;
      case 'address':
        out.push(
          p.address_public
            ? `${code} is in ${p.locality} — ${p.address_public}. The exact address is shared by the team when they contact you.`
            : `${code} is in ${p.locality}. The exact address isn't published; the team can share it.`,
        );
        break;
      case 'photos':
        out.push(p.images.length ? `${code} has ${p.images.length} photo${p.images.length === 1 ? '' : 's'} — shown on the card.` : `There are no photos recorded for ${code} yet.`);
        break;
      case 'amenities':
        if (amenityAsked) {
          out.push(
            p.amenities.includes(amenityAsked as never)
              ? `${code}: ${humanise(amenityAsked)} is listed among its amenities.`
              : NOT_RECORDED(capitalise(humanise(amenityAsked)), code),
          );
        } else {
          out.push(p.amenities.length ? `${code} lists these amenities: ${p.amenities.map(humanise).join(', ')}.` : NOT_RECORDED('Amenities', code));
        }
        break;
      case 'description':
        out.push(
          `${code} — ${p.title}: ${formatPrice(p.price_amount, p.price_period)}, ${p.bedrooms !== null ? `${p.bedrooms}BHK ` : ''}${humanise(p.property_type)} in ${p.locality}` +
            `${p.area_sqft ? `, ~${p.area_sqft.toLocaleString('en-IN')} sq.ft` : ''}, ${p.furnishing === 'unknown' ? 'furnishing not recorded' : humanise(p.furnishing)}.` +
            `${p.description ? ` ${p.description}` : ''}`,
        );
        break;
      case 'other':
        out.push(NOT_RECORDED('That detail (deposit, maintenance or fees)', code));
        break;
    }
  }
  return [...new Set(out)].join(' ');
}

async function compare(q: Queryable, ctx: ExecContext): Promise<Outcome> {
  let { properties, problems } = await resolveRefs(q, ctx);
  if (properties.length < 2 && ctx.interp.property_refs.length === 0 && ctx.lastResults.length >= 2) {
    properties = ctx.lastResults.slice(0, 2);
    problems = [];
  }
  if (properties.length < 2) {
    return { draft: [...problems, 'Which two listings should I compare? For example "compare 1 and 3".'].join(' '), cards: [], facts: {} };
  }
  const fresh = await propertiesRepo.getManyByIds(q, properties.slice(0, 3).map((p) => p.id));
  const items = fresh.map((p) => toCardItem(p, indexIn(ctx, p)));
  const line = (i: PropertyCardItem) =>
    `${i.listing_code}: ${i.price_label}, ${i.bedrooms !== null ? `${i.bedrooms}BHK, ` : ''}${i.locality}, ${i.furnishing === 'unknown' ? 'furnishing not recorded' : humanise(i.furnishing)}, parking ${i.parking === 'unknown' ? 'not recorded' : humanise(i.parking)}, pets ${i.pet_policy === 'unknown' ? 'not recorded' : humanise(i.pet_policy)}${i.area_sqft ? `, ~${i.area_sqft} sq.ft` : ''}.`;
  const cheapest = [...items].sort((a, b) => a.price_amount - b.price_amount)[0]!;
  return {
    draft: `${problems.join(' ')}${problems.length ? '\n' : ''}Side by side:\n${items.map(line).join('\n')}\n${cheapest.listing_code} is the lower-priced option.`,
    cards: [{ type: 'compare', items }],
    facts: { listings: items.map(factOf) },
  };
}

async function shortlist(q: Queryable, ctx: ExecContext): Promise<Outcome> {
  const { properties, problems } = await resolveRefs(q, ctx);
  if (properties.length === 0) {
    return { draft: problems.join(' ') || 'Which listing should I save? Say "save the first one" or give its code.', cards: [], facts: {} };
  }
  const saved: string[] = [];
  const already: string[] = [];
  for (const p of properties) {
    const created = await shortlistsRepo.add(q, ctx.conversation.customer_id, ctx.conversation.id, p.id);
    (created ? saved : already).push(p.listing_code);
  }
  const parts: string[] = [...problems];
  if (saved.length) parts.push(`Saved ${saved.join(', ')} to your shortlist.`);
  if (already.length) parts.push(`${already.join(', ')} ${already.length > 1 ? 'were' : 'was'} already on your shortlist.`);
  const total = (await shortlistsRepo.listPropertyIds(q, ctx.conversation.id)).length;
  parts.push(`You have ${total} shortlisted listing${total === 1 ? '' : 's'}.`);
  return { draft: parts.join(' '), cards: [], facts: { saved, already } };
}

async function enquiry(q: Queryable, ctx: ExecContext): Promise<Outcome> {
  const { interp } = ctx;
  const enquiryType = interp.intent === 'site_visit' ? 'site_visit' : 'callback';
  const { properties, problems } = await resolveRefs(q, ctx);
  if (problems.length && properties.length === 0) {
    return { draft: `${problems.join(' ')} Which listing is this about?`, cards: [], facts: {} };
  }
  const property = properties[0] ?? null;
  if (enquiryType === 'site_visit' && !property) {
    return {
      draft: 'Which listing would you like to visit? Say "the first one" or give its listing code.',
      cards: [],
      facts: {},
    };
  }

  let customer = await customersRepo.getById(q, ctx.conversation.customer_id);
  if (interp.contact && (interp.contact.name || interp.contact.phone)) {
    customer = await customersRepo.updateContact(q, ctx.conversation.customer_id, {
      display_name: interp.contact.name ?? undefined,
      phone: interp.contact.phone ? normalisePhone(interp.contact.phone) ?? undefined : undefined,
      consent_status: 'granted',
    });
  }

  if (property && property.availability_status === 'deactivated') {
    return { draft: `${property.listing_code} is no longer listed, so I can't raise a request for it.`, cards: [], facts: {} };
  }

  const { lead, created } = await createLead(q, {
    conversation: ctx.conversation,
    propertyId: property?.id ?? null,
    enquiryType,
    preferredTimeText: interp.preferred_time_text,
    preferredVisitAt: interp.preferred_visit_at ? new Date(interp.preferred_visit_at) : null,
    notes: null,
  });

  const needsContact = !customer?.phone;
  const about = property ? ` for ${property.listing_code}` : '';
  const when = lead.preferred_time_text ? ` (requested time: ${lead.preferred_time_text})` : '';
  const statusNote =
    property && property.availability_status !== 'available'
      ? ` Note: ${property.listing_code} is marked "${humanise(property.availability_status)}", so the team will check it first.`
      : '';
  let draft =
    enquiryType === 'site_visit'
      ? `${created ? "I've recorded" : 'You already have'} a site-visit request${about}${when}. This is a request, not a confirmed booking — a team member will contact you to confirm a time.`
      : `${created ? "I've passed" : 'You already have'} a callback request${about} to the ChennaiProperties team.`;
  draft += statusNote;
  draft += needsContact
    ? ' Please share your name and phone number (the form below works) so the team can reach you. Your details are only used to follow up on this enquiry.'
    : ` We'll use the number ending ${customer!.phone!.slice(-4)}.`;

  return {
    draft,
    cards: [
      {
        type: 'lead',
        lead: {
          id: lead.id,
          enquiry_type: lead.enquiry_type,
          status: lead.status,
          listing_code: property?.listing_code ?? null,
          preferred_time_text: lead.preferred_time_text,
        },
        needs_contact: needsContact,
      },
    ],
    facts: { lead: { type: enquiryType, listing: property?.listing_code ?? null, confirmed: false, requested_time: lead.preferred_time_text } },
  };
}

async function provideContact(q: Queryable, ctx: ExecContext): Promise<Outcome> {
  const c = ctx.interp.contact;
  const phone = c?.phone ? normalisePhone(c.phone) : null;
  if (c?.phone && !phone) {
    return { draft: "That phone number doesn't look right — could you send a 10-digit Indian mobile number?", cards: [], facts: {} };
  }
  const customer = await customersRepo.updateContact(q, ctx.conversation.customer_id, {
    display_name: c?.name ?? undefined,
    phone: phone ?? undefined,
    consent_status: 'granted',
  });
  const name = customer.display_name ? `, ${customer.display_name}` : '';
  const hasLead = (await q.query('SELECT 1 FROM leads WHERE conversation_id = $1 LIMIT 1', [ctx.conversation.id])).rows.length > 0;
  return {
    draft: hasLead
      ? `Thanks${name}. I've added your details to your enquiry — the team will contact you${customer.phone ? ` on the number ending ${customer.phone.slice(-4)}` : ''}.`
      : `Thanks${name}, I've noted your details. Would you like a callback or a site visit for one of the listings?`,
    cards: [],
    facts: {},
  };
}

async function faq(q: Queryable, ctx: ExecContext): Promise<Outcome> {
  const entry = ctx.interp.faq_key ? await faqRepo.get(q, ctx.interp.faq_key) : null;
  if (!entry) {
    return {
      draft: "I don't have that information recorded. I can ask the team to get back to you — would you like a callback?",
      cards: [{ type: 'quick_replies', options: [{ label: 'Request a callback', message: 'Please call me back' }] }],
      facts: {},
    };
  }
  return { draft: entry.answer, cards: [], facts: { faq: entry.answer } };
}

// ---------------------------------------------------------------------------------------------

function rankedToCard(r: RankedProperty, index: number): PropertyCardItem {
  return toCardItem(r.property, index, { reasons: r.reasons, caveats: r.caveats });
}

function shortLine(i: PropertyCardItem): string {
  return `${i.title}, ${i.price_label}${i.availability_status === 'pending_confirmation' ? ' (pending confirmation)' : ''}`;
}

function factOf(i: PropertyCardItem) {
  return {
    index: i.index,
    listing_code: i.listing_code,
    title: i.title,
    locality: i.locality,
    price: i.price_label,
    bedrooms: i.bedrooms,
    furnishing: i.furnishing,
    parking: i.parking,
    pet_policy: i.pet_policy,
    amenities: i.amenities,
    status: i.availability_status,
    caveats: i.caveats,
    is_demo: i.is_demo,
  };
}

export function normalisePhone(raw: string): string | null {
  const digits = raw.replace(/[^\d+]/g, '').replace(/^\+?91(?=\d{10}$)/, '').replace(/^0(?=\d{10}$)/, '');
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AiError('timeout', 'AI step timed out', true)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
