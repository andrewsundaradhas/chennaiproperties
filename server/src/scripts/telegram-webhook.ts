// Registers or removes the production webhook. Usage:
//   npm run telegram:webhook -- --url https://your-api.example.com/api/telegram/webhook
//   npm run telegram:webhook -- --delete        (required before local long polling works again)
//   npm run telegram:webhook -- --info
import { parseArgs } from 'node:util';
import { env } from '../config/env.js';
import { TelegramClient } from '../channels/telegram/api.js';
import { run } from './_db.js';

run(async () => {
  const { values } = parseArgs({ options: { url: { type: 'string' }, delete: { type: 'boolean' }, info: { type: 'boolean' } } });
  const config = env();
  if (!config.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not set in .env');
  const client = new TelegramClient({ token: config.TELEGRAM_BOT_TOKEN });
  if (values.delete) {
    await client.call('deleteWebhook', { drop_pending_updates: false });
    console.log('✔ Webhook removed. Long polling (TELEGRAM_MODE=polling) can be used again.');
  } else if (values.url) {
    if (!/^https:\/\//.test(values.url)) throw new Error('Webhook URL must be https://');
    if (!config.TELEGRAM_WEBHOOK_SECRET) throw new Error('Set TELEGRAM_WEBHOOK_SECRET in .env first (16+ chars of A-Z a-z 0-9 _ -)');
    await client.call('setWebhook', {
      url: values.url,
      secret_token: config.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ['message', 'callback_query'],
    });
    console.log(`✔ Webhook set to ${values.url}. Run the API with TELEGRAM_MODE=webhook.`);
  } else {
    const info = await client.call<{ url: string; pending_update_count: number; last_error_message?: string }>('getWebhookInfo');
    console.log(info.url ? `Webhook: ${info.url} (pending ${info.pending_update_count})${info.last_error_message ? `, last error: ${info.last_error_message}` : ''}` : 'No webhook set (long polling mode available).');
  }
});
