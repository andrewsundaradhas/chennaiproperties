-- Telegram as a customer channel. Backward compatible: existing web rows are untouched.

ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_external_channel_check;
ALTER TABLE customers ADD CONSTRAINT customers_external_channel_check
  CHECK (external_channel IN ('web', 'whatsapp', 'telegram'));

ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_channel_check;
ALTER TABLE conversations ADD CONSTRAINT conversations_channel_check
  CHECK (channel IN ('web', 'whatsapp', 'telegram'));

-- Where to deliver replies (Telegram chat id). Null for web sessions.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS external_chat_id text;
-- Small per-conversation channel UI state, e.g. {"awaiting":"contact"}. Never business data.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS channel_state jsonb NOT NULL DEFAULT '{}';

-- Idempotency: each Telegram update is processed at most once, even across restarts.
CREATE TABLE IF NOT EXISTS telegram_updates (
  bot_id       text   NOT NULL,
  update_id    bigint NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (bot_id, update_id)
);

-- Polling offset and single-consumer lease per bot.
CREATE TABLE IF NOT EXISTS telegram_bot_state (
  bot_id           text PRIMARY KEY,
  last_update_id   bigint,
  lease_owner      text,
  lease_expires_at timestamptz,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE telegram_updates   ENABLE ROW LEVEL SECURITY;
ALTER TABLE telegram_bot_state ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON telegram_updates, telegram_bot_state FROM %I', r);
    END IF;
  END LOOP;
END
$$;
