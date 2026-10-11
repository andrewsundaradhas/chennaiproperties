import { Router } from 'express';
import { z } from 'zod';
import type { Db } from '../../db/client.js';
import { toCardItem } from '../../domain/cards.js';
import { EnquiryType, KnownFurnishing, PropertyType, TransactionType } from '../../domain/enums.js';
import { toPublicProperty } from '../../domain/property.js';
import { EMPTY_REQUIREMENTS } from '../../domain/requirements.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { parseOrThrow } from '../../lib/validation.js';
import { customersRepo } from '../../repositories/conversations.repo.js';
import { isUuid, propertiesRepo } from '../../repositories/properties.repo.js';
import { normalisePhone } from '../../services/conversation.service.js';
import { createLead } from '../../services/lead.service.js';
import { searchProperties, MAX_RESULT_LIMIT } from '../../services/search.service.js';
import { requireChatSession } from '../middleware/auth.js';
import { rateLimit } from '../middleware/common.js';

const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const SearchQuery = z.object({
  transaction_type: TransactionType,
  locality: z.union([z.string().max(60), z.array(z.string().max(60)).max(10)]).optional(),
  budget_min: z.coerce.number().int().positive().optional(),
  budget_max: z.coerce.number().int().positive().optional(),
  bedrooms: z.coerce.number().int().min(0).max(20).optional(),
  property_type: PropertyType.optional(),
  furnishing: KnownFurnishing.optional(),
  parking: bool.optional(),
  pets: bool.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_RESULT_LIMIT).optional(),
});

const LeadBody = z.object({
  session_id: z.string().uuid(),
  property_id: z.string().uuid().nullish(),
  enquiry_type: EnquiryType,
  preferred_time_text: z.string().trim().max(120).nullish(),
  preferred_visit_at: z.iso.datetime({ offset: true }).nullish(),
  notes: z.string().trim().max(1000).nullish(),
  name: z.string().trim().min(1).max(80),
  phone: z.string().trim().min(6).max(20),
  consent: z.literal(true, { error: 'Consent is required to share your details with the team' }),
  idempotency_key: z.string().trim().min(8).max(64).regex(/^[\w-]+$/).optional(),
});

export function publicRoutes(db: Db): Router {
  const r = Router();

  r.get('/health', async (_req, res) => {
    try {
      await db.query('SELECT 1');
      res.json({ status: 'ok', db: 'ok' });
    } catch {
      res.status(503).json({ status: 'degraded', db: 'unavailable' });
    }
  });

  r.get('/properties', rateLimit({ name: 'property_search', windowMs: 60_000, max: 120 }), async (req, res) => {
    const qp = parseOrThrow(SearchQuery, req.query, 'Invalid search filters');
    const locality = qp.locality === undefined ? [] : Array.isArray(qp.locality) ? qp.locality : [qp.locality];
    const result = await searchProperties(
      db,
      {
        ...EMPTY_REQUIREMENTS,
        transaction_type: qp.transaction_type,
        locality_terms: locality,
        budget_min: qp.budget_min ?? null,
        budget_max: qp.budget_max ?? null,
        bedrooms: qp.bedrooms ?? null,
        property_type: qp.property_type ?? null,
        furnishing: qp.furnishing ?? null,
        parking_required: qp.parking ?? null,
        pets_required: qp.pets ?? null,
      },
      { limit: qp.limit },
    );
    res.json({
      status: result.status,
      total_matches: result.totalMatches,
      applied_filters: result.appliedFilters,
      items: result.results.map((r, i) => toCardItem(r.property, i + 1, { reasons: r.reasons, caveats: r.caveats })),
      near_match: result.nearMatch
        ? {
            explanation: result.nearMatch.explanation,
            items: result.nearMatch.results.map((r, i) => toCardItem(r.property, i + 1, { reasons: r.reasons, caveats: r.caveats })),
          }
        : null,
    });
  });

  r.get('/properties/:id', async (req, res) => {
    const id = String(req.params.id);
    const p = isUuid(id) ? await propertiesRepo.getById(db, id) : await propertiesRepo.getByCode(db, id);
    if (!p || p.availability_status === 'deactivated') throw notFound('Property not found');
    res.json({ property: toPublicProperty(p) });
  });

  r.post(
    '/leads',
    rateLimit({ name: 'lead_create', windowMs: 60_000, max: 10 }),
    requireChatSession(db),
    async (req, res) => {
      const body = parseOrThrow(LeadBody, req.body);
      const phone = normalisePhone(body.phone);
      if (!phone) throw badRequest('Please enter a valid 10-digit Indian mobile number', [{ field: 'phone', message: 'Invalid phone number' }]);
      const conversation = req.conversation!;
      const result = await db.transaction(async (tx) => {
        await customersRepo.updateContact(tx, conversation.customer_id, {
          display_name: body.name,
          phone,
          consent_status: 'granted',
        });
        return createLead(tx, {
          conversation,
          propertyId: body.property_id ?? null,
          enquiryType: body.enquiry_type,
          preferredTimeText: body.preferred_time_text ?? null,
          preferredVisitAt: body.preferred_visit_at ? new Date(body.preferred_visit_at) : null,
          notes: body.notes ?? null,
          idempotencyKey: body.idempotency_key ?? null,
        });
      });
      res.status(result.created ? 201 : 200).json({
        lead: {
          id: result.lead.id,
          enquiry_type: result.lead.enquiry_type,
          status: result.lead.status,
          preferred_time_text: result.lead.preferred_time_text,
          confirmed: false,
        },
        created: result.created,
        message:
          result.lead.enquiry_type === 'site_visit'
            ? 'Site-visit request recorded. It is not a confirmed booking — the team will contact you to confirm a time.'
            : 'Request recorded. The team will contact you.',
      });
    },
  );

  return r;
}
