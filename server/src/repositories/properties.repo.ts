import type { Queryable } from '../db/client.js';
import type { AvailabilityStatus, Furnishing, PropertyType, TransactionType } from '../domain/enums.js';
import type { Property, PropertyImage, PropertyInput } from '../domain/property.js';

const COLUMNS = `id, listing_code, title, transaction_type, property_type, locality, city, address_public,
  latitude, longitude, bedrooms, bathrooms, area_sqft, price_amount, price_period, currency, furnishing,
  amenities, parking, pet_policy, availability_status, description, source_type, is_demo, created_at,
  updated_at, deactivated_at`;

type Row = Omit<Property, 'images'>;

async function attachImages(q: Queryable, rows: Row[]): Promise<Property[]> {
  if (rows.length === 0) return [];
  const { rows: images } = await q.query<PropertyImage & { property_id: string }>(
    `SELECT id, property_id, image_url, alt_text, sort_order FROM property_images
     WHERE property_id = ANY($1::uuid[]) ORDER BY sort_order, created_at`,
    [rows.map((r) => r.id)],
  );
  return rows.map((r) => ({
    ...r,
    images: images
      .filter((i) => i.property_id === r.id)
      .map(({ id, image_url, alt_text, sort_order }) => ({ id, image_url, alt_text, sort_order })),
  }));
}

async function replaceImages(q: Queryable, propertyId: string, images: PropertyInput['images']) {
  await q.query('DELETE FROM property_images WHERE property_id = $1', [propertyId]);
  for (const [i, img] of images.entries()) {
    await q.query(
      `INSERT INTO property_images (property_id, image_url, alt_text, sort_order) VALUES ($1, $2, $3, $4)`,
      [propertyId, img.image_url, img.alt_text ?? null, i],
    );
  }
}

const valuesOf = (p: PropertyInput) => [
  p.title,
  p.transaction_type,
  p.property_type,
  p.locality,
  p.city,
  p.address_public ?? null,
  p.latitude ?? null,
  p.longitude ?? null,
  p.bedrooms ?? null,
  p.bathrooms ?? null,
  p.area_sqft ?? null,
  p.price_amount,
  p.price_period,
  p.furnishing,
  p.amenities,
  p.parking,
  p.pet_policy,
  p.availability_status,
  p.description ?? null,
];

export const propertiesRepo = {
  async insert(
    q: Queryable,
    p: PropertyInput,
    meta: { source_type: Property['source_type']; is_demo: boolean },
  ): Promise<Property> {
    const { rows } = await q.query<Row>(
      `INSERT INTO properties (listing_code, title, transaction_type, property_type, locality, city,
         address_public, latitude, longitude, bedrooms, bathrooms, area_sqft, price_amount, price_period,
         furnishing, amenities, parking, pet_policy, availability_status, description, source_type, is_demo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
       RETURNING ${COLUMNS}`,
      [p.listing_code, ...valuesOf(p), meta.source_type, meta.is_demo],
    );
    const row = rows[0]!;
    await replaceImages(q, row.id, p.images);
    return (await attachImages(q, [row]))[0]!;
  },

  async update(q: Queryable, id: string, p: PropertyInput): Promise<Property | null> {
    const { rows } = await q.query<Row>(
      `UPDATE properties SET title=$2, transaction_type=$3, property_type=$4, locality=$5, city=$6,
         address_public=$7, latitude=$8, longitude=$9, bedrooms=$10, bathrooms=$11, area_sqft=$12,
         price_amount=$13, price_period=$14, furnishing=$15, amenities=$16, parking=$17, pet_policy=$18,
         availability_status=$19, description=$20, updated_at=now()
       WHERE id=$1 AND deactivated_at IS NULL
       RETURNING ${COLUMNS}`,
      [id, ...valuesOf(p)],
    );
    if (!rows[0]) return null;
    await replaceImages(q, id, p.images);
    return (await attachImages(q, rows))[0]!;
  },

  async deactivate(q: Queryable, id: string): Promise<Property | null> {
    const { rows } = await q.query<Row>(
      `UPDATE properties SET availability_status='deactivated', deactivated_at=now(), updated_at=now()
       WHERE id=$1 AND deactivated_at IS NULL RETURNING ${COLUMNS}`,
      [id],
    );
    return rows[0] ? (await attachImages(q, rows))[0]! : null;
  },

  async getById(q: Queryable, id: string): Promise<Property | null> {
    if (!isUuid(id)) return null;
    const { rows } = await q.query<Row>(`SELECT ${COLUMNS} FROM properties WHERE id=$1`, [id]);
    return rows[0] ? (await attachImages(q, rows))[0]! : null;
  },

  async getByCode(q: Queryable, code: string): Promise<Property | null> {
    const { rows } = await q.query<Row>(`SELECT ${COLUMNS} FROM properties WHERE listing_code=$1`, [
      code.trim().toUpperCase(),
    ]);
    return rows[0] ? (await attachImages(q, rows))[0]! : null;
  },

  async getManyByIds(q: Queryable, ids: string[]): Promise<Property[]> {
    if (ids.length === 0) return [];
    const { rows } = await q.query<Row>(`SELECT ${COLUMNS} FROM properties WHERE id = ANY($1::uuid[])`, [ids]);
    const withImages = await attachImages(q, rows);
    return ids.map((id) => withImages.find((p) => p.id === id)).filter((p): p is Property => !!p);
  },

  /** Hard-filtered candidates for customer search. Ranking happens in the search service. */
  async findCandidates(q: Queryable, f: CandidateFilter): Promise<Property[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (clause: string, value: unknown) => {
      params.push(value);
      where.push(clause.replace('?', `$${params.length}`));
    };
    add('transaction_type = ?', f.transaction_type);
    add('availability_status = ANY(?::text[])', f.statuses);
    if (f.localities) add('locality = ANY(?::text[])', f.localities);
    if (f.budget_max !== undefined) add('price_amount <= ?', f.budget_max);
    if (f.budget_min !== undefined) add('price_amount >= ?', f.budget_min);
    if (f.bedrooms !== undefined) add('bedrooms = ?', f.bedrooms);
    if (f.property_type) add('property_type = ?', f.property_type);
    if (f.furnishing) add('furnishing = ?', f.furnishing);
    // Unknown parking / pet values are kept (and flagged), only confirmed "no" is excluded.
    if (f.parking_required) where.push(`parking <> 'not_available'`);
    if (f.pets_required) where.push(`pet_policy <> 'not_allowed'`);
    const { rows } = await q.query<Row>(
      `SELECT ${COLUMNS} FROM properties WHERE ${where.join(' AND ')}
       ORDER BY updated_at DESC LIMIT 200`,
      params,
    );
    return attachImages(q, rows);
  },

  async listAdmin(
    q: Queryable,
    f: {
      status?: AvailabilityStatus;
      transaction_type?: TransactionType;
      locality?: string;
      search?: string;
      limit: number;
      offset: number;
    },
  ): Promise<{ items: Property[]; total: number }> {
    const where: string[] = ['true'];
    const params: unknown[] = [];
    const add = (clause: string, value: unknown) => {
      params.push(value);
      where.push(clause.replaceAll('?', `$${params.length}`));
    };
    if (f.status) add('availability_status = ?', f.status);
    if (f.transaction_type) add('transaction_type = ?', f.transaction_type);
    if (f.locality) add('locality = ?', f.locality);
    if (f.search) add(`(listing_code ILIKE ? OR title ILIKE ?)`, `%${f.search.replace(/[%_\\]/g, '\\$&')}%`);
    const whereSql = where.join(' AND ');
    const { rows: countRows } = await q.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM properties WHERE ${whereSql}`,
      params,
    );
    const { rows } = await q.query<Row>(
      `SELECT ${COLUMNS} FROM properties WHERE ${whereSql}
       ORDER BY updated_at DESC, listing_code LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, f.limit, f.offset],
    );
    return { items: await attachImages(q, rows), total: countRows[0]?.total ?? 0 };
  },

  async countActive(q: Queryable): Promise<number> {
    const { rows } = await q.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM properties WHERE availability_status IN ('available','pending_confirmation')`,
    );
    return rows[0]?.n ?? 0;
  },
};

export interface CandidateFilter {
  transaction_type: TransactionType;
  statuses: AvailabilityStatus[];
  localities?: string[];
  budget_min?: number;
  budget_max?: number;
  bedrooms?: number;
  property_type?: PropertyType;
  furnishing?: Exclude<Furnishing, 'unknown'>;
  parking_required?: boolean;
  pets_required?: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID_RE.test(s);
