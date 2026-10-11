import type { Queryable } from '../db/client.js';
import { SEARCHABLE_STATUSES } from '../domain/enums.js';
import { formatPrice, formatInr, formatInrCompact, humanise } from '../domain/format.js';
import { corridorOf, localitiesInCorridor, resolveLocalityTerms } from '../domain/localities.js';
import type { Property } from '../domain/property.js';
import type { Requirements } from '../domain/requirements.js';
import { propertiesRepo, type CandidateFilter } from '../repositories/properties.repo.js';

export const DEFAULT_RESULT_LIMIT = 5;
export const MAX_RESULT_LIMIT = 10;

export interface RankedProperty {
  property: Property;
  score: number;
  /** Why it matches — built only from stored fields. */
  reasons: string[];
  /** Things the customer should know: unknown values, pending status. */
  caveats: string[];
}

export type Relaxation = 'budget' | 'bedrooms' | 'locality' | 'furnishing' | 'property_type';

export interface SearchOutcome {
  status: 'ok' | 'needs_transaction_type' | 'unknown_locality';
  results: RankedProperty[];
  totalMatches: number;
  nearMatch?: { relaxed: Relaxation; explanation: string; results: RankedProperty[] };
  unresolvedLocalities: string[];
  /** Human-readable summary of the filters actually applied. */
  appliedFilters: string[];
}

export async function searchProperties(
  q: Queryable,
  req: Requirements,
  opts: { limit?: number } = {},
): Promise<SearchOutcome> {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_RESULT_LIMIT, 1), MAX_RESULT_LIMIT);
  const base: SearchOutcome = {
    status: 'ok',
    results: [],
    totalMatches: 0,
    unresolvedLocalities: [],
    appliedFilters: describeFilters(req),
  };
  if (!req.transaction_type) return { ...base, status: 'needs_transaction_type' };

  const loc = resolveLocalityTerms(req.locality_terms);
  base.unresolvedLocalities = loc.unknown;
  if (req.locality_terms.length > 0 && loc.localities.length === 0 && loc.corridors.length === 0) {
    return { ...base, status: 'unknown_locality' };
  }
  const exactLocalities = loc.localities;
  const allLocalities =
    req.locality_terms.length > 0
      ? [...new Set([...exactLocalities, ...loc.corridors.flatMap(localitiesInCorridor)])]
      : undefined;

  const filter = toFilter(req, allLocalities);
  const ranked = rank(await propertiesRepo.findCandidates(q, filter), req, exactLocalities);
  if (ranked.length > 0) {
    return { ...base, results: ranked.slice(0, limit), totalMatches: ranked.length };
  }

  // No exact match: try one controlled relaxation at a time and label it clearly.
  for (const relax of relaxations(req, exactLocalities, allLocalities)) {
    const near = rank(await propertiesRepo.findCandidates(q, relax.filter), req, exactLocalities);
    if (near.length > 0) {
      return {
        ...base,
        nearMatch: { relaxed: relax.kind, explanation: relax.explanation, results: near.slice(0, 3) },
      };
    }
  }
  return base;
}

function toFilter(req: Requirements, localities: string[] | undefined): CandidateFilter {
  return {
    transaction_type: req.transaction_type!,
    statuses: SEARCHABLE_STATUSES,
    localities,
    budget_min: req.budget_min ?? undefined,
    budget_max: req.budget_max ?? undefined,
    bedrooms: req.bedrooms ?? undefined,
    property_type: req.property_type ?? undefined,
    furnishing: req.furnishing ?? undefined,
    parking_required: req.parking_required ?? undefined,
    pets_required: req.pets_required ?? undefined,
  };
}

function relaxations(
  req: Requirements,
  exactLocalities: string[],
  allLocalities: string[] | undefined,
): { kind: Relaxation; filter: CandidateFilter; explanation: string }[] {
  const out: { kind: Relaxation; filter: CandidateFilter; explanation: string }[] = [];
  const base = toFilter(req, allLocalities);
  if (req.budget_max) {
    const raised = Math.round((req.budget_max * 1.15) / 500) * 500;
    const fmt = req.transaction_type === 'sale' ? formatInrCompact : formatInr;
    out.push({
      kind: 'budget',
      filter: { ...base, budget_max: raised },
      explanation: `slightly above your budget (up to ${fmt(raised)} instead of ${fmt(req.budget_max)})`,
    });
  }
  if (req.property_type) {
    // "house" is often used loosely for any home, so other property types are a useful near match.
    out.push({
      kind: 'property_type',
      filter: { ...base, property_type: undefined },
      explanation: `${req.property_type === 'apartment' ? 'not apartments' : `other property types (no ${humanise(req.property_type)} matched)`}`,
    });
  }
  if (req.furnishing) {
    out.push({
      kind: 'furnishing',
      filter: { ...base, furnishing: undefined },
      explanation: `not ${humanise(req.furnishing)} (or furnishing not recorded)`,
    });
  }
  if (req.bedrooms !== null && req.bedrooms > 0) {
    // Separate passes so the explanation names the exact difference.
    for (const b of [req.bedrooms - 1, req.bedrooms + 1].filter((b) => b > 0)) {
      out.push({
        kind: 'bedrooms',
        filter: { ...base, bedrooms: b },
        explanation: `${b}BHK instead of ${req.bedrooms}BHK`,
      });
    }
  }
  const corridors = [...new Set(exactLocalities.map(corridorOf).filter((c) => c !== undefined))];
  if (exactLocalities.length > 0 && corridors.length > 0) {
    const nearby = corridors.flatMap(localitiesInCorridor).filter((l) => !exactLocalities.includes(l));
    if (nearby.length > 0) {
      out.push({
        kind: 'locality',
        filter: { ...base, localities: nearby },
        explanation: `in a nearby area (${corridors.join(', ')} side) rather than ${exactLocalities.join(' / ')}`,
      });
    }
  }
  return out;
}

export function rank(candidates: Property[], req: Requirements, exactLocalities: string[]): RankedProperty[] {
  const ranked = candidates.map((p) => {
    let score = 0;
    const reasons: string[] = [];
    const caveats: string[] = [];

    if (exactLocalities.includes(p.locality)) {
      score += 3;
      reasons.push(`in ${p.locality}`);
    } else if (req.locality_terms.length > 0) {
      score += 1;
      reasons.push(`in ${p.locality}${corridorOf(p.locality) ? ` (${corridorOf(p.locality)})` : ''}`);
    }
    if (req.bedrooms !== null && p.bedrooms === req.bedrooms) reasons.push(`${p.bedrooms}BHK`);
    if (req.property_type && p.property_type === req.property_type) reasons.push(humanise(p.property_type));
    if (req.budget_max !== null) {
      const fmt = p.transaction_type === 'sale' ? formatInrCompact : formatInr;
      reasons.push(`${formatPrice(p.price_amount, p.price_period)} — within ${fmt(req.budget_max)}`);
    }
    if (req.furnishing && p.furnishing === req.furnishing) reasons.push(humanise(p.furnishing));

    if (req.parking_required) {
      if (p.parking === 'available') {
        score += 1;
        reasons.push('parking available');
      } else caveats.push('Parking is not recorded for this listing');
    }
    if (req.pets_required) {
      if (p.pet_policy === 'allowed') {
        score += 1;
        reasons.push('pets allowed');
      } else if (p.pet_policy === 'case_by_case') caveats.push('Pets considered case by case');
      else caveats.push('Pet policy is not recorded for this listing');
    }
    for (const a of req.amenities) {
      if (p.amenities.includes(a)) {
        score += 1;
        reasons.push(`has ${humanise(a)}`);
      } else caveats.push(`${capitalise(humanise(a))} is not recorded for this listing`);
    }

    if (p.availability_status === 'available') score += 2;
    else caveats.push('Availability pending confirmation by the team');

    return { property: p, score, reasons, caveats };
  });
  // Best score first; then lower price; then most recently updated.
  return ranked.sort(
    (a, b) =>
      b.score - a.score ||
      a.property.price_amount - b.property.price_amount ||
      b.property.updated_at.getTime() - a.property.updated_at.getTime(),
  );
}

export function describeFilters(req: Requirements): string[] {
  const out: string[] = [];
  if (req.transaction_type) out.push(req.transaction_type === 'rent' ? 'for rent' : 'for sale');
  if (req.bedrooms !== null) out.push(`${req.bedrooms}BHK`);
  if (req.property_type) out.push(humanise(req.property_type));
  if (req.locality_terms.length) out.push(`in ${req.locality_terms.join(' / ')}`);
  const fmt = req.transaction_type === 'sale' ? formatInrCompact : formatInr;
  if (req.budget_min !== null && req.budget_max !== null) out.push(`${fmt(req.budget_min)}–${fmt(req.budget_max)}`);
  else if (req.budget_max !== null) out.push(`under ${fmt(req.budget_max)}`);
  else if (req.budget_min !== null) out.push(`above ${fmt(req.budget_min)}`);
  if (req.furnishing) out.push(humanise(req.furnishing));
  if (req.parking_required) out.push('with parking');
  if (req.pets_required) out.push('pet-friendly');
  for (const a of req.amenities) out.push(`with ${humanise(a)}`);
  return out;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
