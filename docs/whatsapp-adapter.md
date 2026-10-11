# WhatsApp channel: adapter boundary (deferred)

Status: **not implemented, by design.** No WhatsApp number is connected, migrated or registered in this phase.

## Why it is cheap to add later

The conversation logic is channel-agnostic. `handleCustomerMessage(deps, conversation, text, { clientMessageId })` in `server/src/services/conversation.service.ts` is the only entry point. The web chat calls it today, and a WhatsApp webhook would call the same function. Search, AI interpretation, requirements, leads and persistence are all shared, so nothing is duplicated.

The schema is already in place:

- `customers.external_channel` accepts `'whatsapp'`, with `external_user_id` holding the WhatsApp `wa_id`. The pair is unique.
- `conversations.channel = 'whatsapp'`, with a null `session_token_hash` (the Meta signature authenticates instead).
- `messages.provider_message_id` holds the `wamid`. A unique index makes webhook retries idempotent.

## What the adapter needs (when scheduled)

1. `GET /api/webhooks/whatsapp`: the verification handshake using `WHATSAPP_VERIFY_TOKEN`.
2. `POST /api/webhooks/whatsapp`:
   - Verify `X-Hub-Signature-256` with `WHATSAPP_APP_SECRET` against the **raw** body, before JSON parsing.
   - For each inbound text message: `customersRepo.upsert(db, 'whatsapp', wa_id)`, then reuse `conversationsRepo.latestActiveForCustomer` or create a conversation.
   - Call `handleCustomerMessage(..., { clientMessageId: wamid })`.
   - Respond 200 quickly. Do the AI work asynchronously, or within Meta's timeout.
3. Send the reply via the Cloud API (`WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`). `toWhatsAppPayloads()` in `server/src/channels/whatsapp.ts` already turns replies and quick-reply chips into text payloads.
4. Respect the 24-hour customer-service window and template rules for messages the business starts.

## Before onboarding

Complete Meta business verification, get an approved display name and number, choose a BSP or the direct Cloud API, budget for message categories, and review consent and retention (PRD §10.3, Appendix C).
