// Deterministic interpreter for common phrasings. Used when no Gemini key is configured and as
// the fallback when the model fails. It never invents facts; it only maps words to filters.
import type { Amenity, PropertyType } from '../domain/enums.js';
import { findLocalityMentions } from '../domain/localities.js';
import type { RequirementsPatch } from '../domain/requirements.js';
import type { AiProvider, InterpretInput } from './provider.js';
import {
  InterpretationSchema,
  type Interpretation,
  type Intent,
  type PropertyRef,
  type QuestionField,
} from './schemas.js';

const ORDINALS: Record<string, number> = {
  first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4, fifth: 5, '5th': 5,
};

const AMENITY_WORDS: [RegExp, Amenity][] = [
  [/\bgym\b|fitness/, 'gym'],
  [/swimming|\bpool\b/, 'swimming_pool'],
  [/\blift\b|elevator/, 'lift'],
  [/power ?back ?up|generator|\bdg\b/, 'power_backup'],
  [/security|guard|cctv/, 'security'],
  [/club ?house/, 'clubhouse'],
  [/garden/, 'garden'],
  [/gated/, 'gated_community'],
  [/play ?area|kids area|children/, 'children_play_area'],
  [/metro/, 'metro_nearby'],
  [/24.?7 water|water supply/, 'water_supply_24x7'],
];

/** Parses "25k", "₹25,000", "1.2 cr", "80 lakhs" → rupees. */
export function parseAmount(raw: string): number | null {
  const m = raw
    .toLowerCase()
    .replace(/,/g, '')
    .match(/(\d+(?:\.\d+)?)\s*(k|thousand|l|lac|lacs|lakh|lakhs|cr|crore|crores)?\b/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] ?? '';
  const mult = /^(k|thousand)$/.test(unit) ? 1e3 : /^(l|lac|lacs|lakh|lakhs)$/.test(unit) ? 1e5 : /^(cr|crore|crores)$/.test(unit) ? 1e7 : 1;
  const value = Math.round(n * mult);
  return value > 0 ? value : null;
}

const AMOUNT = String.raw`(?:rs\.?|inr|₹)?\s*(\d[\d,]*(?:\.\d+)?\s*(?:k|thousand|lakhs?|lacs?|l|crores?|cr)?)\b`;

function extractBudget(t: string): { min?: number; max?: number } {
  const between = t.match(new RegExp(String.raw`between\s+${AMOUNT}\s+(?:and|to|-)\s+${AMOUNT}`));
  if (between) {
    const a = parseAmount(between[1]!);
    const b = parseAmount(between[2]!);
    if (a && b) return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  const range = t.match(new RegExp(String.raw`${AMOUNT}\s*(?:-|to)\s*${AMOUNT}`));
  if (range && /k|lakh|lac|cr|₹|rs|budget/.test(range[0])) {
    const a = parseAmount(range[1]!);
    const b = parseAmount(range[2]!);
    if (a && b && a !== b) return { min: Math.min(a, b), max: Math.max(a, b) };
  }
  const max = t.match(new RegExp(String.raw`(?:under|below|within|less than|upto|up to|max(?:imum)?|not more than|stretch (?:it )?to|go up to|can (?:afford|pay|spend)|afford|budget(?: is| of)?(?: around| about)?|around|about|<)\s*${AMOUNT}`));
  if (max) {
    const v = parseAmount(max[1]!);
    if (v && v >= 1000) return { max: v };
  }
  // Postfix forms: "30k max", "30k or less", Tanglish "30k kulla" (= within 30k).
  const postfix = t.match(new RegExp(String.raw`${AMOUNT}\s*(?:kulla|kula|max|maximum|or less|and below|budget)\b`));
  if (postfix) {
    const v = parseAmount(postfix[1]!);
    if (v && v >= 1000) return { max: v };
  }
  const min = t.match(new RegExp(String.raw`(?:above|over|more than|at least|minimum|min|>)\s*${AMOUNT}`));
  if (min) {
    const v = parseAmount(min[1]!);
    if (v && v >= 1000) return { min: v };
  }
  return {};
}

function extractRefs(t: string, raw: string): PropertyRef[] {
  const refs: PropertyRef[] = [];
  for (const m of raw.matchAll(/\b([A-Za-z]{2,}-(?:[A-Za-z]+-)?\d{2,})\b/g)) {
    refs.push({ kind: 'code', code: m[1]!.toUpperCase() });
  }
  for (const m of t.matchAll(/\b(first|1st|second|2nd|third|3rd|fourth|4th|fifth|5th)\b(?:\s+(?:one|listing|property|flat|option|house|result))?/g)) {
    const idx = ORDINALS[m[1]!]!;
    if (!refs.some((r) => r.kind === 'index' && r.index === idx)) refs.push({ kind: 'index', index: idx });
  }
  for (const m of t.matchAll(/(?:#|\bno\.?\s*|\bnumber\s+|\boption\s+|\blisting\s+)(\d{1,2})\b/g)) {
    const idx = Number(m[1]);
    if (idx >= 1 && idx <= 10 && !refs.some((r) => r.kind === 'index' && r.index === idx)) refs.push({ kind: 'index', index: idx });
  }
  if (refs.length === 0 && /\b(last one|the last)\b/.test(t)) refs.push({ kind: 'last' });
  return refs;
}

function extractQuestionFields(t: string): QuestionField[] {
  const f: QuestionField[] = [];
  if (/\bpets?\b|\bdogs?\b|\bcats?\b/.test(t)) f.push('pet_policy');
  if (/parking|car park/.test(t)) f.push('parking');
  if (/furnish/.test(t)) f.push('furnishing');
  if (/price|rent\b|cost|how much|rate/.test(t)) f.push('price');
  if (/availab|still (open|free)|vacant/.test(t)) f.push('availability');
  if (/bathroom|toilet/.test(t)) f.push('bathrooms');
  if (/sq\.? ?ft|square feet|area|size|how big/.test(t)) f.push('area');
  if (/address|where (is|exactly)|location/.test(t)) f.push('address');
  if (/photo|picture|image/.test(t)) f.push('photos');
  if (/deposit|maintenance|advance|brokerage|commission/.test(t)) f.push('other');
  if (AMENITY_WORDS.some(([re]) => re.test(t)) || /amenit/.test(t)) f.push('amenities');
  if (/tell me (more )?about|details|describe|more info/.test(t)) f.push('description');
  return [...new Set(f)];
}

function extractContact(raw: string): { name: string | null; phone: string | null } | null {
  const phoneMatch = raw.match(/(?:\+?91[\s-]?)?([6-9]\d{4}[\s-]?\d{5})\b/);
  const nameMatch = raw.match(/\b(?:my name is|i am|i'm|this is|name[:\s]+)\s*([A-Za-z][A-Za-z .'-]{1,40}?)(?=[,.;!]|\s+(?:and|my|number|phone|here)\b|$)/i);
  const phone = phoneMatch ? phoneMatch[1]!.replace(/[\s-]/g, '') : null;
  const name = nameMatch ? nameMatch[1]!.trim() : null;
  if (!phone && !name) return null;
  // "I am looking for..." is not a name.
  if (name && /^(looking|interested|searching|a |an |the )/i.test(name) && !phone) return null;
  return { name: name && !/^(looking|interested|searching)/i.test(name) ? name : null, phone };
}

function extractTime(t: string): string | null {
  const m = t.match(
    /\b((?:this|next|coming)\s+(?:weekend|week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|today|tomorrow|day after tomorrow|(?:on\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday))(?:[^.?!,]*?\b(?:at|around|by)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\s+(?:morning|afternoon|evening))?/,
  );
  if (m) return m[0].trim();
  const time = t.match(/\b(?:at|around)\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/);
  return time ? time[0] : null;
}

/** Tamil script → 'ta' (or 'mixed' with Latin words); common Tanglish words → 'mixed'. */
export function detectLanguage(raw: string): Interpretation['language'] {
  if (/[\u0B80-\u0BFF]/.test(raw)) return /[a-z]{3,}/i.test(raw) ? 'mixed' : 'ta';
  return /\b(vaadagai|vadagai|vanakkam|venum|vendum|vaanga|vanga|irukka|irukku|enna|kulla|illa|romba|veedu)\b/i.test(raw) ? 'mixed' : 'en';
}

export function interpretWithRules(input: InterpretInput): Interpretation {
  const raw = input.message.trim();
  const t = ` ${raw.toLowerCase().replace(/\s+/g, ' ')} `;
  const set: RequirementsPatch['set'] = {};
  const clear: RequirementsPatch['clear'] = [];

  // --- requirement extraction ---
  if (/\b(rents?|rentals?|renting|leases?|to[- ]let|tenants?|vaadagai|vadagai)\b/.test(t) && !/\bwhat(?:'s| is) the rent\b/.test(t)) set.transaction_type = 'rent';
  if (/\b(buy|buying|purchase|purchasing|for sale|on sale|resale|own a|vaanga|vanga|vaangu)\b/.test(t)) set.transaction_type = 'sale';

  const bhk = t.match(/\b(\d{1,2})\s*-?\s*(?:bhk|bed ?rooms?|beds?|bed)\b/) ?? t.match(/\b(one|two|three|four|five)\s*-?\s*(?:bhk|bed ?rooms?)\b/);
  if (bhk) {
    const words: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
    set.bedrooms = words[bhk[1]!] ?? Number(bhk[1]);
  }

  const budget = extractBudget(t);
  if (budget.max) set.budget_max = budget.max;
  if (budget.min) set.budget_min = budget.min;
  if (budget.max && !budget.min && /\b(actually|change|instead|now)\b/.test(t)) clear.push('budget_min');
  if (/\b(any budget|no budget|budget (is )?flexible)\b/.test(t)) clear.push('budget_min', 'budget_max');

  const localities = findLocalityMentions(raw);
  if (localities.length) set.locality_terms = localities;
  if (/\b(anywhere|any area|any location|any locality)\b/.test(t)) clear.push('locality_terms');

  const ptypes: [RegExp, PropertyType][] = [
    [/\b(independent house|individual house|standalone house|house)\b/, 'independent_house'],
    [/\bvillas?\b/, 'villa'],
    [/\b(plots?|land)\b/, 'plot'],
    [/\b(office|commercial|shop|showroom)\b/, 'commercial'],
    [/\b(apartment|flat)s?\b/, 'apartment'],
  ];
  const ptype = ptypes.find(([re]) => re.test(t));
  if (ptype) set.property_type = ptype[1];

  if (/semi[- ]?furnished/.test(t)) set.furnishing = 'semi_furnished';
  else if (/\b(unfurnished|not furnished|without furniture)\b/.test(t)) set.furnishing = 'unfurnished';
  else if (/\b(fully )?furnished\b/.test(t)) set.furnishing = 'furnished';
  if (/\b(any furnishing|furnishing doesn'?t matter)\b/.test(t)) clear.push('furnishing');
  if (/\b(any (property )?type|any kind of (property|home)|type doesn'?t matter)\b/.test(t)) clear.push('property_type');

  const wantsParking = /\b(with|need|needs|want|require|must have|having)\b[^.?!]{0,20}\bparking\b|\bparking (is )?(needed|required|must)\b/.test(t);
  if (wantsParking) set.parking_required = true;
  if (/\b(no need (for|of) parking|don'?t need parking|parking not needed)\b/.test(t)) clear.push('parking_required');

  const petMention = /\b(pets?|dogs?|cats?|pet[- ]friendly)\b/.test(t);
  const amenities = AMENITY_WORDS.filter(([re]) => re.test(t)).map(([, a]) => a);

  const refs = extractRefs(t, raw);
  const contact = extractContact(raw);
  const timeText = extractTime(t);
  const isQuestion = /\?|\b(does|do|is|are|has|have|can|what|how|which|any)\b/.test(t);
  const cheaper = /\b(cheaper|less expensive|lower (price|rent|budget)|more affordable|reduce (the )?budget)\b/.test(t);
  const pricier = /\b(more expensive|higher (price|rent|budget)|premium|bigger budget|increase (the )?budget)\b/.test(t);
  const fieldsAsked = extractQuestionFields(t);

  // --- intent ---
  let intent: Intent = 'unclear';
  let faqKey: string | null = null;
  const hasSearchSignal =
    Object.keys(set).length > 0 || clear.length > 0 || cheaper || pricier || (amenities.length > 0 && refs.length === 0) || (petMention && refs.length === 0 && !isQuestion);

  if (/\b(site visit|visit|see the (flat|house|property|place|apartment)|viewing|inspect|come and see)\b/.test(t) && !/how (do|does) (site )?visits? work/.test(t)) intent = 'site_visit';
  else if (
    !/how (do|does) callbacks? work/.test(t) &&
    (/\b(call ?back|call me|contact me|get in touch|reach me|speak to|talk to)\b/.test(t) ||
      (/\b(enquire|enquiry|i'?m interested|interested in)\b/.test(t) && (!hasSearchSignal || refs.length > 0)))
  )
    intent = 'callback';
  else if (/\b(compare|comparison|difference between|vs\.?|versus)\b/.test(t)) intent = 'compare';
  else if (/\b(shortlist|bookmark|favou?rite)\b|\bsave (it|this|that|the|them|#|number|option|listing)|\badd (it |this )?to (my )?list\b/.test(t)) intent = 'shortlist';
  else if (contact && !hasSearchSignal && refs.length === 0) intent = 'provide_contact';
  else if (refs.length > 0 && (fieldsAsked.length > 0 || isQuestion || /tell me|more about|details/.test(t))) intent = 'property_question';
  else if (/\b(show (me )?more|more (options|results|listings)|any others|anything else|other options)\b/.test(t) && !hasSearchSignal) intent = 'show_more';
  else if (/how (do|does) (site )?visits? work|booking a visit/.test(t)) [intent, faqKey] = ['faq', 'site_visits'];
  else if (/how (do|does) callbacks? work/.test(t)) [intent, faqKey] = ['faq', 'callbacks'];
  else if (/\b(my data|privacy|personal (data|information)|what happens to my)\b/.test(t)) [intent, faqKey] = ['faq', 'data_use'];
  else if (/\b(who are you|what is this|what can you do|are you (a )?(bot|ai|real))\b/.test(t)) [intent, faqKey] = ['faq', 'about_assistant'];
  else if (/\b(brokerage|commission|office hours|working hours|deposit rules|your fees?)\b/.test(t) && refs.length === 0) [intent, faqKey] = ['faq', 'unknown'];
  else if (hasSearchSignal) {
    const hasExisting = input.requirements.transaction_type !== null || input.requirements.locality_terms.length > 0 || input.requirements.budget_max !== null || input.requirements.bedrooms !== null;
    intent = hasExisting ? 'refine' : 'search';
  } else if (refs.length > 0) intent = 'property_question';
  else if (fieldsAsked.length > 0 && input.lastResults.length > 0 && isQuestion) intent = 'property_question';
  else if (/^\s*(hi|hello|hey|hai|vanakkam|good (morning|afternoon|evening)|namaste)\b/.test(t)) intent = 'greeting';

  // Pets: a search preference unless the customer is asking about a specific listing.
  if (petMention && (intent === 'search' || intent === 'refine')) set.pets_required = true;
  if (amenities.length > 0 && (intent === 'search' || intent === 'refine')) {
    set.amenities = [...new Set([...input.requirements.amenities, ...amenities])];
  }

  const language = detectLanguage(raw);

  return InterpretationSchema.parse({
    intent,
    requirements: { set, clear: [...new Set(clear)], confidence: {} },
    relative_budget: cheaper ? 'cheaper' : pricier ? 'more_expensive' : null,
    property_refs: refs,
    question_fields: intent === 'property_question' ? (fieldsAsked.length ? fieldsAsked : ['description']) : [],
    amenity_asked: intent === 'property_question' ? (amenities[0] ?? null) : null,
    faq_key: faqKey,
    contact,
    preferred_time_text: intent === 'site_visit' || intent === 'callback' ? timeText : null,
    language,
  });
}

export class RulesProvider implements AiProvider {
  readonly name = 'rules';
  async interpret(input: InterpretInput): Promise<Interpretation> {
    return interpretWithRules(input);
  }
}
