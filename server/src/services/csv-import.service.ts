import { parse } from 'csv-parse/sync';
import type { Db } from '../db/client.js';
import { PropertyInputSchema, type PropertyInput } from '../domain/property.js';
import { propertiesRepo } from '../repositories/properties.repo.js';
import { auditRepo } from '../repositories/admin.repo.js';
import { resolveLocalityTerm } from '../domain/localities.js';

export const CSV_COLUMNS = [
  'listing_code',
  'title',
  'transaction_type',
  'property_type',
  'locality',
  'address_public',
  'bedrooms',
  'bathrooms',
  'area_sqft',
  'price_amount',
  'price_period',
  'furnishing',
  'amenities',
  'parking',
  'pet_policy',
  'availability_status',
  'description',
  'image_urls',
] as const;
const REQUIRED = ['listing_code', 'title', 'transaction_type', 'property_type', 'locality', 'price_amount', 'price_period'];

export interface CsvRowError {
  row: number; // 1-based data row (header excluded), matching what spreadsheet users see minus header
  listing_code?: string;
  errors: string[];
}

export interface CsvImportReport {
  dryRun: boolean;
  totalRows: number;
  valid: number;
  imported: number;
  errors: CsvRowError[];
}

const MAX_ROWS = 1000;

/**
 * All-or-nothing: if any row is invalid (or its code already exists), nothing is imported.
 * This avoids silently importing a partial or malformed inventory.
 */
export async function importPropertiesCsv(
  db: Db,
  csv: string,
  opts: { dryRun: boolean; actorId?: string },
): Promise<CsvImportReport> {
  let records: Record<string, string>[];
  try {
    records = parse(csv, { columns: (h: string[]) => h.map((c) => c.trim().toLowerCase()), skip_empty_lines: true, trim: true, bom: true });
  } catch (err) {
    return { dryRun: opts.dryRun, totalRows: 0, valid: 0, imported: 0, errors: [{ row: 0, errors: [`Could not parse CSV: ${(err as Error).message}`] }] };
  }
  if (records.length > MAX_ROWS) {
    return { dryRun: opts.dryRun, totalRows: records.length, valid: 0, imported: 0, errors: [{ row: 0, errors: [`Too many rows (max ${MAX_ROWS})`] }] };
  }
  const header = records[0] ? Object.keys(records[0]) : [];
  const missingCols = REQUIRED.filter((c) => !header.includes(c));
  if (records.length > 0 && missingCols.length > 0) {
    return { dryRun: opts.dryRun, totalRows: records.length, valid: 0, imported: 0, errors: [{ row: 0, errors: [`Missing required columns: ${missingCols.join(', ')}`] }] };
  }

  const errors: CsvRowError[] = [];
  const valid: PropertyInput[] = [];
  const seenCodes = new Set<string>();

  for (const [i, rec] of records.entries()) {
    const rowErrors: string[] = [];
    const parsed = PropertyInputSchema.safeParse(toCandidate(rec, rowErrors));
    const code = rec.listing_code?.toUpperCase();
    if (!parsed.success) {
      for (const issue of parsed.error.issues) rowErrors.push(`${issue.path.join('.') || 'row'}: ${issue.message}`);
    } else {
      if (seenCodes.has(parsed.data.listing_code)) rowErrors.push('listing_code: duplicated within this file');
      seenCodes.add(parsed.data.listing_code);
      const existing = await propertiesRepo.getByCode(db, parsed.data.listing_code);
      if (existing) rowErrors.push('listing_code: already exists in the inventory');
    }
    if (rowErrors.length > 0) errors.push({ row: i + 1, listing_code: code, errors: rowErrors });
    else if (parsed.success) valid.push(parsed.data);
  }

  const report: CsvImportReport = { dryRun: opts.dryRun, totalRows: records.length, valid: valid.length, imported: 0, errors };
  if (opts.dryRun || errors.length > 0 || valid.length === 0) return report;

  await db.transaction(async (tx) => {
    for (const p of valid) await propertiesRepo.insert(tx, p, { source_type: 'csv_import', is_demo: false });
    await auditRepo.record(tx, {
      actor_type: opts.actorId ? 'admin' : 'system',
      actor_id: opts.actorId ?? 'cli',
      action: 'property.csv_import',
      entity_type: 'property',
      details: { count: valid.length },
    });
  });
  return { ...report, imported: valid.length };
}

function toCandidate(rec: Record<string, string>, rowErrors: string[]): Record<string, unknown> {
  const blank = (v: string | undefined) => v === undefined || v.trim() === '';
  const num = (field: string) => {
    const v = rec[field];
    if (blank(v)) return undefined;
    const n = Number(v!.replace(/[,₹\s]/g, ''));
    if (!Number.isFinite(n)) rowErrors.push(`${field}: "${v}" is not a number`);
    return Number.isFinite(n) ? n : undefined;
  };
  const str = (field: string) => (blank(rec[field]) ? undefined : rec[field]!.trim());
  const list = (field: string) =>
    blank(rec[field]) ? [] : rec[field]!.split(/[|;]/).map((s) => s.trim()).filter(Boolean);

  return {
    listing_code: str('listing_code'),
    title: str('title'),
    transaction_type: str('transaction_type')?.toLowerCase(),
    property_type: str('property_type')?.toLowerCase(),
    locality: str('locality') && (resolveLocalityTerm(str('locality')!).locality ?? str('locality')),
    address_public: str('address_public'),
    bedrooms: num('bedrooms'),
    bathrooms: num('bathrooms'),
    area_sqft: num('area_sqft'),
    price_amount: num('price_amount'),
    price_period: str('price_period')?.toLowerCase(),
    furnishing: str('furnishing')?.toLowerCase(),
    amenities: list('amenities').map((a) => a.toLowerCase()),
    parking: str('parking')?.toLowerCase(),
    pet_policy: str('pet_policy')?.toLowerCase(),
    availability_status: str('availability_status')?.toLowerCase(),
    description: str('description'),
    images: list('image_urls').map((image_url) => ({ image_url })),
  };
}
