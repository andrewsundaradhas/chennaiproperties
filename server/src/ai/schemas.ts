import { z } from 'zod';
import { Amenity } from '../domain/enums.js';
import { RequirementsPatchSchema } from '../domain/requirements.js';

export const Intent = z.enum([
  'search', // new or broadened property search
  'refine', // change to an existing search ("only furnished", "budget is 30k")
  'show_more', // more results for the current search
  'property_question', // question about specific listing(s)
  'compare',
  'shortlist',
  'callback',
  'site_visit',
  'provide_contact', // customer shares name / phone
  'faq',
  'greeting',
  'unclear',
]);
export type Intent = z.infer<typeof Intent>;

/** A reference to a listing: by position in the current result set, or by listing code. */
export const PropertyRef = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('index'), index: z.number().int().min(1).max(10) }),
  z.object({ kind: z.literal('code'), code: z.string().trim().min(3).max(40) }),
  z.object({ kind: z.literal('last') }),
]);
export type PropertyRef = z.infer<typeof PropertyRef>;

export const QuestionField = z.enum([
  'price',
  'availability',
  'pet_policy',
  'parking',
  'furnishing',
  'amenities',
  'bedrooms',
  'bathrooms',
  'area',
  'address',
  'description',
  'photos',
  'other',
]);
export type QuestionField = z.infer<typeof QuestionField>;

/**
 * The ONLY thing the model produces for planning. It never contains property facts —
 * those come from backend tools. Validated before anything is executed.
 */
export const InterpretationSchema = z.object({
  intent: Intent,
  requirements: RequirementsPatchSchema.default({ set: {}, clear: [], confidence: {} }),
  relative_budget: z.enum(['cheaper', 'more_expensive']).nullable().default(null),
  property_refs: z.array(PropertyRef).max(4).default([]),
  question_fields: z.array(QuestionField).max(6).default([]),
  amenity_asked: Amenity.nullable().default(null),
  faq_key: z.string().max(60).nullable().default(null),
  contact: z
    .object({
      name: z.string().trim().min(1).max(80).nullable().default(null),
      phone: z.string().trim().min(6).max(20).nullable().default(null),
    })
    .nullable()
    .default(null),
  preferred_time_text: z.string().trim().max(120).nullable().default(null),
  preferred_visit_at: z.iso.datetime({ offset: true }).nullable().default(null),
  language: z.enum(['en', 'ta', 'mixed']).default('en'),
});
export type Interpretation = z.infer<typeof InterpretationSchema>;
