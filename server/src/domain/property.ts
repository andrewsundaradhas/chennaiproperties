import { z } from 'zod';
import {
  Amenity,
  AvailabilityStatus,
  Furnishing,
  Parking,
  PetPolicy,
  PricePeriod,
  PropertyType,
  TransactionType,
} from './enums.js';
import { isKnownLocality } from './localities.js';

export const ImageInput = z.object({
  image_url: z
    .string()
    .trim()
    .max(2000)
    .regex(/^(https?:\/\/|\/)\S+$/, 'Image URL must be an http(s) URL or a site-relative path'),
  alt_text: z.string().trim().max(200).nullish(),
});

/** Fields an admin (or the CSV importer) may set. Status 'deactivated' goes through its own endpoint. */
export const PropertyInputSchema = z
  .object({
    listing_code: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9][A-Z0-9-]{2,39}$/, 'Listing code: 3–40 letters, digits or dashes'),
    title: z.string().trim().min(3).max(200),
    transaction_type: TransactionType,
    property_type: PropertyType,
    locality: z.string().trim().refine(isKnownLocality, 'Unknown locality — choose one from the list'),
    city: z.string().trim().min(2).max(60).default('Chennai'),
    address_public: z.string().trim().max(300).nullish(),
    latitude: z.number().min(-90).max(90).nullish(),
    longitude: z.number().min(-180).max(180).nullish(),
    bedrooms: z.number().int().min(0).max(20).nullish(),
    bathrooms: z.number().int().min(0).max(20).nullish(),
    area_sqft: z.number().int().positive().max(1_000_000).nullish(),
    price_amount: z.number().int().positive().max(2_000_000_000),
    price_period: PricePeriod,
    furnishing: Furnishing.default('unknown'),
    amenities: z.array(Amenity).max(20).default([]),
    parking: Parking.default('unknown'),
    pet_policy: PetPolicy.default('unknown'),
    availability_status: AvailabilityStatus.exclude(['deactivated']).default('available'),
    description: z.string().trim().max(4000).nullish(),
    images: z.array(ImageInput).max(20).default([]),
  })
  .superRefine((p, ctx) => {
    if (p.transaction_type === 'rent' && p.price_period === 'total') {
      ctx.addIssue({ code: 'custom', path: ['price_period'], message: 'Rentals use a monthly price' });
    }
    if (p.transaction_type === 'sale' && p.price_period === 'monthly') {
      ctx.addIssue({ code: 'custom', path: ['price_period'], message: 'Sale listings cannot be priced monthly' });
    }
  });
export type PropertyInput = z.infer<typeof PropertyInputSchema>;

/** PATCH: every field optional; validated against the merged record by the service. */
export const PropertyPatchSchema = z
  .object({
    title: z.string(),
    transaction_type: z.string(),
    property_type: z.string(),
    locality: z.string(),
    city: z.string(),
    address_public: z.string().nullable(),
    latitude: z.number().nullable(),
    longitude: z.number().nullable(),
    bedrooms: z.number().nullable(),
    bathrooms: z.number().nullable(),
    area_sqft: z.number().nullable(),
    price_amount: z.number(),
    price_period: z.string(),
    furnishing: z.string(),
    amenities: z.array(z.string()),
    parking: z.string(),
    pet_policy: z.string(),
    availability_status: z.string(),
    description: z.string().nullable(),
    images: z.array(z.object({ image_url: z.string(), alt_text: z.string().nullish() })),
  })
  .partial()
  .strict();

export interface PropertyImage {
  id: string;
  image_url: string;
  alt_text: string | null;
  sort_order: number;
}

export interface Property {
  id: string;
  listing_code: string;
  title: string;
  transaction_type: z.infer<typeof TransactionType>;
  property_type: z.infer<typeof PropertyType>;
  locality: string;
  city: string;
  address_public: string | null;
  latitude: number | null;
  longitude: number | null;
  bedrooms: number | null;
  bathrooms: number | null;
  area_sqft: number | null;
  price_amount: number;
  price_period: z.infer<typeof PricePeriod>;
  currency: 'INR';
  furnishing: z.infer<typeof Furnishing>;
  amenities: Amenity[];
  parking: z.infer<typeof Parking>;
  pet_policy: z.infer<typeof PetPolicy>;
  availability_status: z.infer<typeof AvailabilityStatus>;
  description: string | null;
  source_type: 'demo_seed' | 'manual' | 'csv_import';
  is_demo: boolean;
  created_at: Date;
  updated_at: Date;
  deactivated_at: Date | null;
  images: PropertyImage[];
}

/** What customers may see. Internal fields (source, deactivation, coordinates) are omitted. */
export interface PublicProperty {
  id: string;
  listing_code: string;
  title: string;
  transaction_type: Property['transaction_type'];
  property_type: Property['property_type'];
  locality: string;
  city: string;
  address_public: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  area_sqft: number | null;
  price_amount: number;
  price_period: Property['price_period'];
  currency: 'INR';
  furnishing: Property['furnishing'];
  amenities: Amenity[];
  parking: Property['parking'];
  pet_policy: Property['pet_policy'];
  availability_status: Property['availability_status'];
  description: string | null;
  is_demo: boolean;
  updated_at: string;
  images: { image_url: string; alt_text: string | null }[];
}

export function toPublicProperty(p: Property): PublicProperty {
  return {
    id: p.id,
    listing_code: p.listing_code,
    title: p.title,
    transaction_type: p.transaction_type,
    property_type: p.property_type,
    locality: p.locality,
    city: p.city,
    address_public: p.address_public,
    bedrooms: p.bedrooms,
    bathrooms: p.bathrooms,
    area_sqft: p.area_sqft,
    price_amount: p.price_amount,
    price_period: p.price_period,
    currency: p.currency,
    furnishing: p.furnishing,
    amenities: p.amenities,
    parking: p.parking,
    pet_policy: p.pet_policy,
    availability_status: p.availability_status,
    description: p.description,
    is_demo: p.is_demo,
    updated_at: p.updated_at.toISOString(),
    images: p.images.map((i) => ({ image_url: i.image_url, alt_text: i.alt_text })),
  };
}
