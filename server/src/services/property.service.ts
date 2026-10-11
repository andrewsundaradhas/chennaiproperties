import type { Db } from '../db/client.js';
import { conflict, notFound, badRequest } from '../lib/errors.js';
import {
  PropertyInputSchema,
  PropertyPatchSchema,
  type Property,
  type PropertyInput,
} from '../domain/property.js';
import { propertiesRepo } from '../repositories/properties.repo.js';
import { auditRepo } from '../repositories/admin.repo.js';
import { zodDetails } from '../lib/validation.js';

const isUniqueViolation = (err: unknown) =>
  typeof err === 'object' && err !== null && 'code' in err && (err as { code: string }).code === '23505';

export async function createProperty(db: Db, actorId: string, body: unknown): Promise<Property> {
  const parsed = PropertyInputSchema.safeParse(body);
  if (!parsed.success) throw badRequest('Invalid property', zodDetails(parsed.error));
  try {
    return await db.transaction(async (tx) => {
      const p = await propertiesRepo.insert(tx, parsed.data, { source_type: 'manual', is_demo: false });
      await auditRepo.record(tx, {
        actor_type: 'admin',
        actor_id: actorId,
        action: 'property.create',
        entity_type: 'property',
        entity_id: p.id,
        details: { listing_code: p.listing_code },
      });
      return p;
    });
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict(`Listing code ${parsed.data.listing_code} already exists`);
    throw err;
  }
}

export async function updateProperty(db: Db, actorId: string, id: string, body: unknown): Promise<Property> {
  const patch = PropertyPatchSchema.safeParse(body);
  if (!patch.success) throw badRequest('Invalid property update', zodDetails(patch.error));
  const existing = await propertiesRepo.getById(db, id);
  if (!existing) throw notFound('Property not found');
  if (existing.deactivated_at) throw conflict('Deactivated listings cannot be edited');

  // Validate the merged record so cross-field rules (e.g. rent must be monthly) still hold.
  const merged = PropertyInputSchema.safeParse({ ...toInput(existing), ...patch.data });
  if (!merged.success) throw badRequest('Invalid property update', zodDetails(merged.error));

  return db.transaction(async (tx) => {
    const updated = await propertiesRepo.update(tx, id, merged.data);
    if (!updated) throw notFound('Property not found');
    await auditRepo.record(tx, {
      actor_type: 'admin',
      actor_id: actorId,
      action: 'property.update',
      entity_type: 'property',
      entity_id: id,
      details: { fields: Object.keys(patch.data) },
    });
    return updated;
  });
}

export async function deactivateProperty(db: Db, actorId: string, id: string): Promise<Property> {
  return db.transaction(async (tx) => {
    const p = await propertiesRepo.deactivate(tx, id);
    if (!p) {
      const existing = await propertiesRepo.getById(tx, id);
      if (!existing) throw notFound('Property not found');
      throw conflict('Listing is already deactivated');
    }
    await auditRepo.record(tx, {
      actor_type: 'admin',
      actor_id: actorId,
      action: 'property.deactivate',
      entity_type: 'property',
      entity_id: id,
      details: { listing_code: p.listing_code },
    });
    return p;
  });
}

export function toInput(p: Property): PropertyInput {
  return {
    listing_code: p.listing_code,
    title: p.title,
    transaction_type: p.transaction_type,
    property_type: p.property_type,
    locality: p.locality,
    city: p.city,
    address_public: p.address_public,
    latitude: p.latitude,
    longitude: p.longitude,
    bedrooms: p.bedrooms,
    bathrooms: p.bathrooms,
    area_sqft: p.area_sqft,
    price_amount: p.price_amount,
    price_period: p.price_period,
    furnishing: p.furnishing,
    amenities: p.amenities,
    parking: p.parking,
    pet_policy: p.pet_policy,
    availability_status: p.availability_status === 'deactivated' ? 'unavailable' : p.availability_status,
    description: p.description,
    images: p.images.map((i) => ({ image_url: i.image_url, alt_text: i.alt_text })),
  };
}
