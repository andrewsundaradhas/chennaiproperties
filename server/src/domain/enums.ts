import { z } from 'zod';

export const TransactionType = z.enum(['rent', 'sale']);
export const PropertyType = z.enum([
  'apartment',
  'independent_house',
  'villa',
  'plot',
  'commercial',
  'other',
]);
export const AvailabilityStatus = z.enum([
  'available',
  'pending_confirmation',
  'unavailable',
  'deactivated',
]);
export const PricePeriod = z.enum(['monthly', 'total', 'per_sqft', 'negotiable']);
export const Furnishing = z.enum(['unfurnished', 'semi_furnished', 'furnished', 'unknown']);
export const KnownFurnishing = z.enum(['unfurnished', 'semi_furnished', 'furnished']);
export const PetPolicy = z.enum(['allowed', 'not_allowed', 'case_by_case', 'unknown']);
export const Parking = z.enum(['available', 'not_available', 'unknown']);
export const LeadStatus = z.enum([
  'new',
  'contacted',
  'visit_requested',
  'qualified',
  'closed',
  'spam',
]);
export const EnquiryType = z.enum(['callback', 'site_visit', 'general']);
export const Channel = z.enum(['web', 'whatsapp']);

export type TransactionType = z.infer<typeof TransactionType>;
export type PropertyType = z.infer<typeof PropertyType>;
export type AvailabilityStatus = z.infer<typeof AvailabilityStatus>;
export type PricePeriod = z.infer<typeof PricePeriod>;
export type Furnishing = z.infer<typeof Furnishing>;
export type PetPolicy = z.infer<typeof PetPolicy>;
export type Parking = z.infer<typeof Parking>;
export type LeadStatus = z.infer<typeof LeadStatus>;
export type EnquiryType = z.infer<typeof EnquiryType>;
export type Channel = z.infer<typeof Channel>;

/** Statuses a customer search may return. Pending ones must be shown as unconfirmed. */
export const SEARCHABLE_STATUSES: AvailabilityStatus[] = ['available', 'pending_confirmation'];

/** Controlled amenity vocabulary used by search, forms and CSV import. */
export const AMENITIES = [
  'lift',
  'power_backup',
  'security',
  'gym',
  'swimming_pool',
  'clubhouse',
  'children_play_area',
  'covered_parking',
  'gated_community',
  'water_supply_24x7',
  'garden',
  'metro_nearby',
] as const;
export const Amenity = z.enum(AMENITIES);
export type Amenity = z.infer<typeof Amenity>;
