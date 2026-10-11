import { z } from 'zod';
import { Amenity, KnownFurnishing, PropertyType, TransactionType } from './enums.js';

/** A customer's current requirements. null / [] means "not stated" — never an assumed value. */
export const RequirementsSchema = z.object({
  transaction_type: TransactionType.nullable(),
  locality_terms: z.array(z.string().trim().min(1).max(60)).max(10),
  budget_min: z.number().int().positive().nullable(),
  budget_max: z.number().int().positive().nullable(),
  bedrooms: z.number().int().min(0).max(20).nullable(),
  property_type: PropertyType.nullable(),
  furnishing: KnownFurnishing.nullable(),
  parking_required: z.boolean().nullable(),
  pets_required: z.boolean().nullable(),
  amenities: z.array(Amenity).max(12),
});
export type Requirements = z.infer<typeof RequirementsSchema>;

export const REQUIREMENT_FIELDS = Object.keys(RequirementsSchema.shape) as (keyof Requirements)[];
export const RequirementField = z.enum(REQUIREMENT_FIELDS as [keyof Requirements, ...(keyof Requirements)[]]);
export type RequirementField = z.infer<typeof RequirementField>;

export const Confidence = z.enum(['explicit', 'inferred']);
export type Confidence = z.infer<typeof Confidence>;

/**
 * A change to requirements. Fields in `set` overwrite; fields in `clear` are reset to "not stated";
 * every other field is left untouched. This is how "actually my budget is 30k" keeps the location.
 */
export const RequirementsPatchSchema = z.object({
  set: z
    .object({
      transaction_type: TransactionType,
      locality_terms: z.array(z.string().trim().min(1).max(60)).min(1).max(10),
      budget_min: z.number().int().positive(),
      budget_max: z.number().int().positive(),
      bedrooms: z.number().int().min(0).max(20),
      property_type: PropertyType,
      furnishing: KnownFurnishing,
      parking_required: z.boolean(),
      pets_required: z.boolean(),
      amenities: z.array(Amenity).max(12),
    })
    .partial()
    .default({}),
  clear: z.array(RequirementField).default([]),
  confidence: z.partialRecord(RequirementField, Confidence).default({}),
});
export type RequirementsPatch = z.infer<typeof RequirementsPatchSchema>;

export const EMPTY_REQUIREMENTS: Requirements = {
  transaction_type: null,
  locality_terms: [],
  budget_min: null,
  budget_max: null,
  bedrooms: null,
  property_type: null,
  furnishing: null,
  parking_required: null,
  pets_required: null,
  amenities: [],
};

export type ConfidenceMap = Partial<Record<RequirementField, Confidence>>;

export function mergeRequirements(
  current: Requirements,
  currentConfidence: ConfidenceMap,
  patch: RequirementsPatch,
): { requirements: Requirements; confidence: ConfidenceMap; changed: RequirementField[] } {
  const next: Requirements = { ...current };
  const confidence: ConfidenceMap = { ...currentConfidence };
  const changed: RequirementField[] = [];

  for (const field of patch.clear) {
    const empty = EMPTY_REQUIREMENTS[field];
    if (JSON.stringify(next[field]) !== JSON.stringify(empty)) changed.push(field);
    (next as Record<string, unknown>)[field] = empty;
    delete confidence[field];
  }
  for (const [field, value] of Object.entries(patch.set) as [RequirementField, unknown][]) {
    if (value === undefined) continue;
    if (JSON.stringify(next[field]) !== JSON.stringify(value)) changed.push(field);
    (next as Record<string, unknown>)[field] = value;
    confidence[field] = patch.confidence[field] ?? 'explicit';
  }

  // Keep the budget range coherent: a new maximum below the old minimum drops the minimum.
  if (next.budget_min !== null && next.budget_max !== null && next.budget_min > next.budget_max) {
    if (patch.set.budget_max !== undefined) next.budget_min = null;
    else next.budget_max = null;
  }

  return { requirements: RequirementsSchema.parse(next), confidence, changed: [...new Set(changed)] };
}

export function hasSearchableRequirements(r: Requirements): boolean {
  return (
    r.locality_terms.length > 0 ||
    r.budget_max !== null ||
    r.bedrooms !== null ||
    r.property_type !== null
  );
}
