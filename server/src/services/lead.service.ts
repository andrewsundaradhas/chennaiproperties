import type { Queryable } from '../db/client.js';
import type { EnquiryType } from '../domain/enums.js';
import { conflict, notFound } from '../lib/errors.js';
import type { Conversation } from '../repositories/conversations.repo.js';
import { leadsRepo, type Lead } from '../repositories/leads.repo.js';
import { propertiesRepo } from '../repositories/properties.repo.js';
import { auditRepo } from '../repositories/admin.repo.js';

export interface CreateLeadInput {
  conversation: Conversation;
  propertyId?: string | null;
  enquiryType: EnquiryType;
  preferredVisitAt?: Date | null;
  preferredTimeText?: string | null;
  notes?: string | null;
  idempotencyKey?: string | null;
}

/**
 * Records an enquiry. A site-visit lead is only ever "visit_requested" — this system has no
 * booking mechanism, so nothing here confirms an appointment.
 */
export async function createLead(q: Queryable, input: CreateLeadInput): Promise<{ lead: Lead; created: boolean }> {
  const { conversation } = input;
  const propertyId = input.propertyId ?? null;
  if (propertyId) {
    const p = await propertiesRepo.getById(q, propertyId);
    if (!p) throw notFound('Property not found');
    if (p.availability_status === 'deactivated') throw conflict('That listing is no longer active');
  }
  if (!input.idempotencyKey) {
    const dup = await leadsRepo.findOpenDuplicate(q, conversation.id, propertyId, input.enquiryType);
    if (dup) return { lead: dup, created: false };
  }
  const result = await leadsRepo.create(q, {
    customer_id: conversation.customer_id,
    conversation_id: conversation.id,
    property_id: propertyId,
    enquiry_type: input.enquiryType,
    status: input.enquiryType === 'site_visit' ? 'visit_requested' : 'new',
    preferred_visit_at: input.preferredVisitAt ?? null,
    preferred_time_text: input.preferredTimeText ?? null,
    notes: input.notes ?? null,
    idempotency_key: input.idempotencyKey ? `${conversation.id}:${input.idempotencyKey}` : null,
  });
  if (result.created) {
    await auditRepo.record(q, {
      actor_type: 'customer',
      actor_id: conversation.customer_id,
      action: 'lead.create',
      entity_type: 'lead',
      entity_id: result.lead.id,
      details: { enquiry_type: input.enquiryType, has_property: propertyId !== null },
    });
  }
  return result;
}
