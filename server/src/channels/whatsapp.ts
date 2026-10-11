// FUTURE WhatsApp channel adapter — boundary only. NOT wired into the app in this phase.
//
// When scheduled, a webhook route would:
//   1. Verify the Meta signature (X-Hub-Signature-256 with WHATSAPP_APP_SECRET) and the
//      GET verification handshake (WHATSAPP_VERIFY_TOKEN).
//   2. For each inbound text message, upsert the customer with
//      customersRepo.upsert(db, 'whatsapp', <wa_id>) and find/create an active conversation
//      (conversationsRepo.latestActiveForCustomer / create with a null session token).
//   3. Call handleCustomerMessage(deps, conversation, text, { clientMessageId: <wamid> }).
//      The wamid makes webhook retries idempotent (messages.provider_message_id is unique).
//   4. Render the reply through toWhatsAppPayloads() and send via the Cloud API.
//
// No other module needs to change: search, AI interpretation, leads and persistence are shared.
import type { Card } from '../domain/cards.js';

export interface WhatsAppTextPayload {
  type: 'text';
  text: { body: string };
}

/** Renders a reply for WhatsApp: text only; cards collapse into the text that already lists them. */
export function toWhatsAppPayloads(body: string, cards: Card[]): WhatsAppTextPayload[] {
  const extra = cards
    .filter((c): c is Extract<Card, { type: 'quick_replies' }> => c.type === 'quick_replies')
    .flatMap((c) => c.options.map((o) => `• ${o.message}`));
  const text = extra.length ? `${body}\n\nYou can reply with:\n${extra.join('\n')}` : body;
  return [{ type: 'text', text: { body: text.slice(0, 4096) } }];
}
