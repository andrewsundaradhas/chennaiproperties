import { Router, type Response } from 'express';
import { z } from 'zod';
import type { Env } from '../../config/env.js';
import type { Db } from '../../db/client.js';
import { toMessageDto } from '../../channels/web.js';
import {
  AMENITIES,
  AvailabilityStatus,
  Furnishing,
  LeadStatus,
  Parking,
  PetPolicy,
  PricePeriod,
  PropertyType,
  TransactionType,
} from '../../domain/enums.js';
import { LOCALITIES } from '../../domain/localities.js';
import type { Property } from '../../domain/property.js';
import { randomToken, sha256, verifyPassword, hashPassword } from '../../lib/crypto.js';
import { badRequest, notFound, unauthorized } from '../../lib/errors.js';
import { parseOrThrow } from '../../lib/validation.js';
import { adminRepo, auditRepo } from '../../repositories/admin.repo.js';
import {
  customersRepo,
  messagesRepo,
  requirementsRepo,
  shortlistsRepo,
  conversationsRepo,
} from '../../repositories/conversations.repo.js';
import { leadsRepo } from '../../repositories/leads.repo.js';
import { isUuid, propertiesRepo } from '../../repositories/properties.repo.js';
import { importPropertiesCsv } from '../../services/csv-import.service.js';
import { createProperty, deactivateProperty, updateProperty } from '../../services/property.service.js';
import { describeFilters } from '../../services/search.service.js';
import { ADMIN_COOKIE, readCookie, requireAdmin } from '../middleware/auth.js';
import type { TelegramStatus } from '../../channels/telegram/poller.js';
import { rateLimit, requireJsonForMutations } from '../middleware/common.js';

const SESSION_HOURS = 12;

const LoginBody = z.object({ email: z.string().trim().email().max(200), password: z.string().min(1).max(200) });
const Paging = {
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(20),
};
const PropertyListQuery = z.object({
  status: AvailabilityStatus.optional(),
  transaction_type: TransactionType.optional(),
  locality: z.string().max(60).optional(),
  search: z.string().trim().max(80).optional(),
  ...Paging,
});
const LeadListQuery = z.object({ status: LeadStatus.optional(), ...Paging });
const LeadPatch = z
  .object({
    status: LeadStatus,
    assigned_agent: z.string().trim().max(120).nullable(),
    notes: z.string().trim().max(4000).nullable(),
  })
  .partial()
  .strict();
const ImportBody = z.object({ csv: z.string().min(1).max(2_000_000), dry_run: z.boolean().default(true) });

// Admins see full records; the response still omits nothing secret (there are no secrets on rows).
function adminProperty(p: Property) {
  return { ...p, created_at: p.created_at.toISOString(), updated_at: p.updated_at.toISOString(), deactivated_at: p.deactivated_at?.toISOString() ?? null };
}

// Pre-computed so login takes similar time whether or not the email exists.
const DUMMY_HASH = hashPassword('timing-equaliser-not-a-real-password');

export function adminRoutes(db: Db, env: Env, telegramStatus: () => TelegramStatus | null = () => null): Router {
  const r = Router();
  r.use(requireJsonForMutations);

  const setSessionCookie = (res: Response, token: string, maxAgeMs: number) => {
    res.cookie(ADMIN_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: env.COOKIE_SECURE,
      path: '/api',
      maxAge: maxAgeMs,
    });
  };

  // --- auth ---
  r.post('/auth/login', rateLimit({ name: 'admin_login', windowMs: 15 * 60_000, max: 10 }), async (req, res) => {
    const body = parseOrThrow(LoginBody, req.body);
    const admin = await adminRepo.findByEmail(db, body.email);
    const ok = admin?.password_hash
      ? await verifyPassword(body.password, admin.password_hash)
      : (await verifyPassword(body.password, await DUMMY_HASH), false);
    if (!admin || !ok) throw unauthorized('Incorrect email or password');
    const token = randomToken();
    await adminRepo.createSession(db, admin.id, sha256(token), new Date(Date.now() + SESSION_HOURS * 3600_000));
    await auditRepo.record(db, { actor_type: 'admin', actor_id: admin.id, action: 'admin.login', entity_type: 'admin_user', entity_id: admin.id });
    setSessionCookie(res, token, SESSION_HOURS * 3600_000);
    res.json({ admin: { email: admin.email, display_name: admin.display_name, role: admin.role } });
  });

  r.post('/auth/logout', async (req, res) => {
    const token = readCookie(req, ADMIN_COOKIE);
    if (token) await adminRepo.deleteSession(db, sha256(token));
    res.clearCookie(ADMIN_COOKIE, { path: '/api' });
    res.json({ ok: true });
  });

  // Everything below requires an authenticated admin.
  r.use(requireAdmin(db));

  r.get('/auth/me', (req, res) => {
    const a = req.admin!;
    res.json({ admin: { email: a.email, display_name: a.display_name, role: a.role } });
  });

  r.get('/meta', (_req, res) => {
    res.json({
      localities: LOCALITIES.map((l) => ({ name: l.name, corridor: l.corridor ?? null })),
      amenities: AMENITIES,
      enums: {
        transaction_type: TransactionType.options,
        property_type: PropertyType.options,
        availability_status: AvailabilityStatus.options,
        price_period: PricePeriod.options,
        furnishing: Furnishing.options,
        parking: Parking.options,
        pet_policy: PetPolicy.options,
        lead_status: LeadStatus.options,
      },
    });
  });

  r.get('/overview', async (_req, res) => {
    const [active, leads, demo] = await Promise.all([
      propertiesRepo.countActive(db),
      leadsRepo.counts(db),
      db.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM properties WHERE is_demo = true AND availability_status IN ('available', 'pending_confirmation')",
      ),
    ]);
    res.json({
      active_properties: active,
      new_leads: leads.new_leads,
      visit_requests: leads.visit_requests,
      total_leads: leads.total,
      demo_properties: demo.rows[0]?.n ?? 0,
      telegram: telegramStatus(),
    });
  });

  // --- properties ---
  r.get('/properties', async (req, res) => {
    const qp = parseOrThrow(PropertyListQuery, req.query, 'Invalid filters');
    const { items, total } = await propertiesRepo.listAdmin(db, {
      status: qp.status,
      transaction_type: qp.transaction_type,
      locality: qp.locality,
      search: qp.search,
      limit: qp.page_size,
      offset: (qp.page - 1) * qp.page_size,
    });
    res.json({ items: items.map(adminProperty), total, page: qp.page, page_size: qp.page_size });
  });

  r.get('/properties/:id', async (req, res) => {
    const p = await propertiesRepo.getById(db, String(req.params.id));
    if (!p) throw notFound('Property not found');
    res.json({ property: adminProperty(p) });
  });

  r.post('/properties', async (req, res) => {
    const p = await createProperty(db, req.admin!.id, req.body);
    res.status(201).json({ property: adminProperty(p) });
  });

  r.post('/properties/import', async (req, res) => {
    const body = parseOrThrow(ImportBody, req.body);
    const report = await importPropertiesCsv(db, body.csv, { dryRun: body.dry_run, actorId: req.admin!.id });
    // The validation report is the result, so it is returned with 200 even when rows are invalid.
    res.json({ report });
  });

  r.patch('/properties/:id', async (req, res) => {
    const id = String(req.params.id);
    if (!isUuid(id)) throw notFound('Property not found');
    const p = await updateProperty(db, req.admin!.id, id, req.body);
    res.json({ property: adminProperty(p) });
  });

  r.post('/properties/:id/deactivate', async (req, res) => {
    const id = String(req.params.id);
    if (!isUuid(id)) throw notFound('Property not found');
    const p = await deactivateProperty(db, req.admin!.id, id);
    res.json({ property: adminProperty(p) });
  });

  // --- leads ---
  r.get('/leads', async (req, res) => {
    const qp = parseOrThrow(LeadListQuery, req.query, 'Invalid filters');
    const { items, total } = await leadsRepo.list(db, { status: qp.status, limit: qp.page_size, offset: (qp.page - 1) * qp.page_size });
    res.json({ items, total, page: qp.page, page_size: qp.page_size });
  });

  r.get('/leads/:id', async (req, res) => {
    const id = String(req.params.id);
    if (!isUuid(id)) throw notFound('Lead not found');
    const lead = await leadsRepo.getById(db, id);
    if (!lead) throw notFound('Lead not found');
    const [customer, property, conversation] = await Promise.all([
      customersRepo.getById(db, lead.customer_id),
      lead.property_id ? propertiesRepo.getById(db, lead.property_id) : null,
      lead.conversation_id ? conversationsRepo.getById(db, lead.conversation_id) : null,
    ]);
    const requirements = conversation ? await requirementsRepo.get(db, conversation.id) : null;
    const shortlistIds = conversation ? await shortlistsRepo.listPropertyIds(db, conversation.id) : [];
    const shortlist = await propertiesRepo.getManyByIds(db, shortlistIds);
    const messages = conversation ? await messagesRepo.list(db, conversation.id, 30) : [];
    res.json({
      lead,
      customer: customer && {
        id: customer.id,
        channel: customer.external_channel,
        display_name: customer.display_name,
        phone: customer.phone,
        consent_status: customer.consent_status,
        preferred_language: customer.preferred_language,
        created_at: customer.created_at,
      },
      property: property ? adminProperty(property) : null,
      requirements: requirements && { ...requirements.requirements, summary: describeFilters(requirements.requirements), confidence: requirements.confidence },
      shortlist: shortlist.map((p) => ({ id: p.id, listing_code: p.listing_code, title: p.title })),
      recent_messages: messages.filter((m) => m.message_type === 'text').map(toMessageDto),
    });
  });

  r.patch('/leads/:id', async (req, res) => {
    const id = String(req.params.id);
    if (!isUuid(id)) throw notFound('Lead not found');
    const patch = parseOrThrow(LeadPatch, req.body, 'Invalid lead update');
    if (Object.keys(patch).length === 0) throw badRequest('Nothing to update');
    const before = await leadsRepo.getById(db, id);
    if (!before) throw notFound('Lead not found');
    const lead = await db.transaction(async (tx) => {
      const updated = await leadsRepo.update(tx, id, patch);
      await auditRepo.record(tx, {
        actor_type: 'admin',
        actor_id: req.admin!.id,
        action: 'lead.update',
        entity_type: 'lead',
        entity_id: id,
        details: {
          fields: Object.keys(patch),
          ...(patch.status && patch.status !== before.status ? { status_from: before.status, status_to: patch.status } : {}),
        },
      });
      return updated!;
    });
    res.json({ lead });
  });

  // --- conversation view (authorised admins only) ---
  r.get('/conversations/:id/messages', async (req, res) => {
    const id = String(req.params.id);
    if (!isUuid(id)) throw notFound('Conversation not found');
    const conv = await conversationsRepo.getById(db, id);
    if (!conv) throw notFound('Conversation not found');
    const messages = await messagesRepo.list(db, id, 200);
    await auditRepo.record(db, { actor_type: 'admin', actor_id: req.admin!.id, action: 'conversation.view', entity_type: 'conversation', entity_id: id });
    res.json({ conversation_id: id, channel: conv.channel, messages: messages.filter((m) => m.message_type === 'text').map(toMessageDto) });
  });

  return r;
}
