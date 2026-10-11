import { Router } from 'express';
import { z } from 'zod';
import { createWebSession, toMessageDto } from '../../channels/web.js';
import { toCardItem } from '../../domain/cards.js';
import { describeFilters } from '../../services/search.service.js';
import { badRequest } from '../../lib/errors.js';
import { parseOrThrow } from '../../lib/validation.js';
import {
  customersRepo,
  messagesRepo,
  requirementsRepo,
  shortlistsRepo,
} from '../../repositories/conversations.repo.js';
import { propertiesRepo } from '../../repositories/properties.repo.js';
import { handleCustomerMessage, normalisePhone, type ConversationDeps } from '../../services/conversation.service.js';
import { requireChatSession } from '../middleware/auth.js';
import { rateLimit } from '../middleware/common.js';

const SendMessageBody = z.object({
  text: z.string().trim().min(1, 'Message is empty').max(2000, 'Message is too long (max 2000 characters)'),
  client_message_id: z.string().trim().min(8).max(64).regex(/^[\w-]+$/).optional(),
});

export const ContactBody = z.object({
  name: z.string().trim().min(1).max(80),
  phone: z.string().trim().min(6).max(20),
  consent: z.literal(true, { error: 'Consent is required to share your details with the team' }),
});

export function chatRoutes(deps: ConversationDeps): Router {
  const { db } = deps;
  const r = Router();
  const auth = requireChatSession(db);

  r.post('/sessions', rateLimit({ name: 'chat_session', windowMs: 60_000, max: 20 }), async (_req, res) => {
    const { sessionId, token } = await createWebSession(db);
    res.status(201).json({ session_id: sessionId, token });
  });

  r.get('/sessions/:id/messages', auth, async (req, res) => {
    const conv = req.conversation!;
    const [messages, req_, shortlistIds] = await Promise.all([
      messagesRepo.list(db, conv.id, 200),
      requirementsRepo.get(db, conv.id),
      shortlistsRepo.listPropertyIds(db, conv.id),
    ]);
    const shortlist = await propertiesRepo.getManyByIds(db, shortlistIds);
    res.json({
      session_id: conv.id,
      messages: messages.filter((m) => m.message_type === 'text').map(toMessageDto),
      requirements: { ...req_.requirements, summary: describeFilters(req_.requirements) },
      shortlist: shortlist.map((p, i) => toCardItem(p, i + 1)),
    });
  });

  r.post(
    '/sessions/:id/messages',
    rateLimit({ name: 'chat_message', windowMs: 60_000, max: 30 }),
    auth,
    async (req, res) => {
      const body = parseOrThrow(SendMessageBody, req.body);
      const result = await handleCustomerMessage(deps, req.conversation!, body.text, {
        clientMessageId: body.client_message_id,
        requestId: req.requestId,
      });
      const { requirements } = await requirementsRepo.get(db, req.conversation!.id);
      res.status(result.duplicate ? 200 : 201).json({
        inbound: toMessageDto(result.inbound),
        reply: toMessageDto(result.reply),
        duplicate: result.duplicate,
        requirements: { ...requirements, summary: describeFilters(requirements) },
      });
    },
  );

  r.post('/sessions/:id/contact', rateLimit({ name: 'chat_contact', windowMs: 60_000, max: 10 }), auth, async (req, res) => {
    const body = parseOrThrow(ContactBody, req.body);
    const phone = normalisePhone(body.phone);
    if (!phone) throw badRequest('Please enter a valid 10-digit Indian mobile number', [{ field: 'phone', message: 'Invalid phone number' }]);
    const customer = await customersRepo.updateContact(db, req.conversation!.customer_id, {
      display_name: body.name,
      phone,
      consent_status: 'granted',
    });
    res.json({ name: customer.display_name, phone_last4: phone.slice(-4) });
  });

  return r;
}
