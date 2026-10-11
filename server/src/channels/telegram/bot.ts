// Telegram channel adapter. It only translates between Telegram updates and the shared
// conversation service — search, AI interpretation, requirements, shortlists and leads are the
// same code paths the web chat uses. Webhook and long polling both call handleUpdate().
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../../db/client.js';
import type { Interpretation } from '../../ai/schemas.js';
import { InterpretationSchema } from '../../ai/schemas.js';
import type { Card, PropertyCardItem } from '../../domain/cards.js';
import { humanise } from '../../domain/format.js';
import { logger } from '../../lib/logger.js';
import {
  conversationsRepo,
  customersRepo,
  messagesRepo,
  shortlistsRepo,
  type Conversation,
  type Message,
} from '../../repositories/conversations.repo.js';
import { propertiesRepo } from '../../repositories/properties.repo.js';
import {
  handleCustomerMessage,
  normalisePhone,
  type ConversationDeps,
} from '../../services/conversation.service.js';
import {
  TelegramApiError,
  type InlineButton,
  type InputFile,
  type ReplyMarkup,
  type TelegramClient,
  type TgCallbackQuery,
  type TgChat,
  type TgMessage,
  type TgUpdate,
  type TgUser,
} from './api.js';

export const TELEGRAM_TEXT_LIMIT = 4096;
const CAPTION_LIMIT = 1024;
const MAX_INBOUND_CHARS = 2000;
const LISTING_CODE_RE = /^[A-Z0-9][A-Z0-9-]{2,39}$/;

export interface TelegramBotOptions {
  db: Db;
  conversation: ConversationDeps;
  client: TelegramClient;
  /** Numeric bot id (from getMe) — namespaces the update-dedupe table. */
  botId: string;
  /** Directory holding site-relative images such as /demo-images/x.png (web/public). */
  publicDir?: string;
  /** Public https origin of the site. When set, site-relative images are sent by URL (serverless). */
  publicBaseUrl?: string;
  maxMessagesPerMinute?: number;
}

const MAIN_MENU: InlineButton[][] = [
  [
    { text: '🏠 Rent a home', callback_data: 'm:rent' },
    { text: '🔑 Buy a property', callback_data: 'm:sale' },
  ],
  [
    { text: '⭐ Compare my shortlist', callback_data: 'cmp' },
    { text: '❓ Help', callback_data: 'help' },
  ],
];

const WELCOME =
  '<b>Welcome to ChennaiProperties AI</b> 🏡\n\n' +
  'Tell me what you need in your own words, for example:\n' +
  '• <i>2BHK for rent in Velachery under 25000</i>\n' +
  '• <i>3BHK flat to buy in Adyar</i>\n' +
  '• <i>pet-friendly house in Anna Nagar</i>\n\n' +
  'I only show listings stored in our database, and I will say so when something is not recorded. ' +
  'You can save listings, compare them, and ask for a callback or site visit.\n\n' +
  '<i>Note: this is a prototype — every listing is sample demonstration data.</i>';

const HELP =
  '<b>How to use this bot</b>\n\n' +
  '<b>Search</b> — just type, e.g. <i>2BHK for rent in Velachery under 25k with parking</i>\n' +
  '<b>Refine</b> — <i>only furnished</i>, <i>actually my budget is 30k</i>, <i>show cheaper ones</i>\n' +
  '<b>Ask</b> — <i>does the second one allow pets?</i>, <i>tell me about CP-DEMO-004</i>\n' +
  '<b>Act</b> — tap Details / Save / Callback / Visit under any listing\n\n' +
  '<b>Commands</b>\n' +
  '/properties — start a property search\n' +
  '/reset — start a fresh search (your past enquiries are kept)\n' +
  '/cancel — cancel the current step (e.g. sharing your number)\n' +
  '/help — this message\n\n' +
  'Site visits are requests only — our team contacts you to confirm a time.';

export class TelegramBot {
  private readonly rate = new Map<number, { windowStart: number; count: number; warned: boolean }>();
  /** Telegram file_id cache so each local image is uploaded once per process. */
  private readonly fileIds = new Map<string, string>();
  /** Serialises work per chat (ordering), while different chats run concurrently. */
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly opts: TelegramBotOptions) {}

  /** Queue an update; returns when it has been processed. Safe to call concurrently. */
  enqueue(update: TgUpdate): Promise<void> {
    const key = String(update.message?.chat.id ?? update.callback_query?.message?.chat.id ?? update.callback_query?.from.id ?? 'other');
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(() => this.handleUpdate(update)).catch(() => undefined);
    this.chains.set(key, next);
    void next.then(() => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    });
    return next;
  }

  async idle(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }

  async handleUpdate(update: TgUpdate): Promise<void> {
    const { db, botId } = this.opts;
    // Idempotency: Telegram may redeliver an update (restart, webhook retry). Claim it first.
    const claim = await db.query(
      `INSERT INTO telegram_updates (bot_id, update_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING update_id`,
      [botId, update.update_id],
    );
    if (claim.rows.length === 0) {
      logger.info('telegram.duplicate_update', { update_id: update.update_id });
      return;
    }
    const chatId = update.message?.chat.id ?? update.callback_query?.message?.chat.id;
    try {
      if (update.callback_query) await this.onCallback(update.callback_query);
      else if (update.message) await this.onMessage(update.message);
      // edited messages, channel posts etc. are deliberately ignored
    } catch (err) {
      logger.error('telegram.update_failed', {
        update_id: update.update_id,
        name: (err as Error)?.name,
        message: this.opts.client.redact(String((err as Error)?.message ?? err)).slice(0, 300),
      });
      if (chatId !== undefined) {
        await this.send(chatId, 'Sorry — something went wrong on our side. Please try again in a moment.').catch(() => undefined);
      }
    }
  }

  // ---------------------------------------------------------------------------------------
  // Inbound messages

  private async onMessage(msg: TgMessage) {
    const from = msg.from;
    if (!from || from.is_bot) return;
    if (msg.chat.type !== 'private') {
      if (msg.text?.startsWith('/start')) await this.send(msg.chat.id, 'Please message me directly (open a private chat with me) to search properties.');
      return;
    }
    if (!this.allow(from.id)) {
      const r = this.rate.get(from.id)!;
      if (!r.warned) {
        r.warned = true;
        await this.send(msg.chat.id, "You're sending messages very quickly — please wait a minute and try again.");
      }
      return;
    }
    const conv = await this.conversationFor(from, msg.chat);

    if (msg.contact) return this.onContact(conv, msg);
    if (typeof msg.text !== 'string') {
      return this.send(msg.chat.id, 'I can only read text messages (and a shared phone number) for now. Please type what you are looking for.');
    }
    const text = msg.text.trim();
    if (!text) return;
    if (text.startsWith('/')) return this.onCommand(conv, msg, text);
    if (text === CANCEL_LABEL) return this.cancel(conv, msg.chat.id);

    await this.converse(conv, text.slice(0, MAX_INBOUND_CHARS), {
      clientMessageId: `tg-${msg.chat.id}-${msg.message_id}`,
    });
  }

  private async onCommand(conv: Conversation, msg: TgMessage, text: string) {
    const chatId = msg.chat.id;
    const command = text.split(/\s+/)[0]!.split('@')[0]!.toLowerCase();
    switch (command) {
      case '/start':
        await this.record(conv, text, 'Welcome message');
        return this.send(chatId, WELCOME, { inline_keyboard: MAIN_MENU }, true);
      case '/help':
        await this.record(conv, text, 'Help message');
        return this.send(chatId, HELP, { inline_keyboard: MAIN_MENU }, true);
      case '/properties':
      case '/search':
        await this.record(conv, text, 'Asked rent or buy');
        return this.send(chatId, "Let's find you a place. Are you looking to rent or to buy?", {
          inline_keyboard: [[MAIN_MENU[0]![0]!, MAIN_MENU[0]![1]!]],
        });
      case '/reset':
        return this.send(
          chatId,
          'Start a fresh search? Your current preferences and results will be cleared from this chat. Your past enquiries stay with our team.',
          { inline_keyboard: [[{ text: 'Yes, start fresh', callback_data: 'rs:y' }, { text: 'No, keep it', callback_data: 'rs:n' }]] },
        );
      case '/cancel':
        return this.cancel(conv, chatId);
      default:
        return this.send(chatId, "I don't know that command. Try /help, or just type what you're looking for.");
    }
  }

  private async cancel(conv: Conversation, chatId: number) {
    if (conv.channel_state?.awaiting) {
      await conversationsRepo.setChannelState(this.opts.db, conv.id, {});
      return this.send(chatId, 'Cancelled. Your request is still recorded — the team can reach you here if you share a number later.', { remove_keyboard: true });
    }
    return this.send(chatId, 'There is nothing to cancel right now.', { remove_keyboard: true });
  }

  private async onContact(conv: Conversation, msg: TgMessage) {
    const contact = msg.contact!;
    const chatId = msg.chat.id;
    // Only accept the sender's own Telegram-verified number, never a forwarded contact.
    if (contact.user_id !== msg.from!.id) {
      return this.send(chatId, 'Please share your own number using the button below, or type your 10-digit mobile number.');
    }
    const phone = normalisePhone(contact.phone_number);
    if (!phone) {
      return this.send(chatId, "That number doesn't look like an Indian mobile number. Please type a 10-digit mobile number the team can call.", { remove_keyboard: true });
    }
    await customersRepo.updateContact(this.opts.db, conv.customer_id, {
      phone,
      display_name: [contact.first_name, contact.last_name].filter(Boolean).join(' ').slice(0, 80) || undefined,
      consent_status: 'granted',
    });
    await conversationsRepo.setChannelState(this.opts.db, conv.id, {});
    const reply = `Thanks! The ChennaiProperties team will contact you on the number ending ${phone.slice(-4)} about your request.`;
    await this.record(conv, '[shared their phone number via Telegram]', reply);
    return this.send(chatId, reply, { remove_keyboard: true });
  }

  // ---------------------------------------------------------------------------------------
  // Button taps

  private async onCallback(cq: TgCallbackQuery) {
    const { client } = this.opts;
    // Always acknowledge so the button stops spinning, even if we then reject the action.
    await client.call('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => undefined);
    const chat = cq.message?.chat;
    if (!chat || chat.type !== 'private' || cq.from.is_bot) return;
    if (!this.allow(cq.from.id)) return;
    const conv = await this.conversationFor(cq.from, chat);
    const data = cq.data ?? '';
    const clientMessageId = `tgcb-${cq.id}`;

    const listing = data.match(/^(d|s|cb|v):(.+)$/);
    if (listing) {
      const code = listing[2]!;
      if (!LISTING_CODE_RE.test(code)) return this.send(chat.id, 'That button is no longer valid. Please search again.');
      const ref = [{ kind: 'code' as const, code }];
      const plan: Record<string, Partial<Interpretation>> = {
        d: { intent: 'property_question', property_refs: ref, question_fields: ['description'] },
        s: { intent: 'shortlist', property_refs: ref },
        cb: { intent: 'callback', property_refs: ref },
        v: { intent: 'site_visit', property_refs: ref },
      };
      const label = { d: 'Details', s: 'Save', cb: 'Request callback', v: 'Request site visit' }[listing[1] as 'd'];
      return this.converse(conv, `[button] ${label}: ${code}`, { clientMessageId, preset: plan[listing[1]!]! });
    }

    switch (data) {
      case 'm:rent':
      case 'm:sale': {
        const t = data === 'm:rent' ? 'rent' : 'sale';
        return this.converse(conv, `[button] ${t === 'rent' ? 'Rent a home' : 'Buy a property'}`, {
          clientMessageId,
          preset: { intent: 'search', requirements: { set: { transaction_type: t }, clear: [], confidence: {} } },
        });
      }
      case 'more':
        return this.converse(conv, '[button] Show more results', { clientMessageId, preset: { intent: 'show_more' } });
      case 'cmp': {
        const ids = await shortlistsRepo.listPropertyIds(this.opts.db, conv.id);
        const props = (await propertiesRepo.getManyByIds(this.opts.db, ids)).filter((p) => p.availability_status !== 'deactivated');
        if (props.length < 2) {
          return this.send(chat.id, 'Save at least two listings (tap ⭐ Save under a listing) and I can compare them side by side.');
        }
        const refs = props.slice(-3).map((p) => ({ kind: 'code' as const, code: p.listing_code }));
        return this.converse(conv, '[button] Compare my shortlist', { clientMessageId, preset: { intent: 'compare', property_refs: refs } });
      }
      case 'help':
        return this.send(chat.id, HELP, { inline_keyboard: MAIN_MENU }, true);
      case 'menu':
        return this.send(chat.id, 'What would you like to do?', { inline_keyboard: MAIN_MENU });
      case 'rs:y':
        await this.reset(conv);
        return this.send(chat.id, 'Fresh start! Tell me what you are looking for, or pick an option:', { inline_keyboard: MAIN_MENU });
      case 'rs:n':
        return this.send(chat.id, 'No problem — your current search is unchanged.');
    }

    const qr = data.match(/^qr:([0-9a-f-]{36}):(\d)$/);
    if (qr) {
      // Look the option up server-side, and only within this user's own conversation.
      const { rows } = await this.opts.db.query<Message>(
        `SELECT * FROM messages WHERE id = $1 AND conversation_id = $2 AND direction = 'outbound'`,
        [qr[1], conv.id],
      );
      const cards = (rows[0]?.metadata_json.cards ?? []) as Card[];
      const options = cards.find((c): c is Extract<Card, { type: 'quick_replies' }> => c.type === 'quick_replies')?.options;
      const option = options?.[Number(qr[2])];
      if (!option) return this.send(chat.id, 'That option has expired. Please type your request instead.');
      return this.converse(conv, option.message, { clientMessageId });
    }

    logger.warn('telegram.unknown_callback', { length: data.length });
    return this.send(chat.id, "Sorry, I didn't recognise that button. Please type your request instead.");
  }

  // ---------------------------------------------------------------------------------------
  // Conversation bridge

  private async converse(
    conv: Conversation,
    text: string,
    opts: { clientMessageId: string; preset?: Partial<Interpretation> },
  ) {
    const chatId = Number(conv.external_chat_id);
    await this.opts.client.call('sendChatAction', { chat_id: chatId, action: 'typing' }, { retries: 0 }).catch(() => undefined);
    const { reply, duplicate } = await handleCustomerMessage(this.opts.conversation, conv, text, {
      clientMessageId: opts.clientMessageId,
      presetInterpretation: opts.preset ? InterpretationSchema.parse(opts.preset) : undefined,
    });
    if (duplicate) return; // already answered this exact message
    await this.render(conv, reply);
  }

  private async render(conv: Conversation, reply: Message) {
    const chatId = Number(conv.external_chat_id);
    const cards = (reply.metadata_json.cards ?? []) as Card[];
    const listCard = cards.find((c): c is Extract<Card, { type: 'properties' }> => c.type === 'properties');

    // Listing cards repeat the numbered lines of the text reply, so drop those lines here.
    let body = reply.body;
    if (listCard) body = body.split('\n').filter((l) => !/^\d+\. [A-Z0-9-]+ — /.test(l)).join('\n');

    const quick = cards.find((c): c is Extract<Card, { type: 'quick_replies' }> => c.type === 'quick_replies');
    const leadCard = cards.find((c): c is Extract<Card, { type: 'lead' }> => c.type === 'lead');

    let markup: ReplyMarkup | undefined;
    if (quick && !listCard) {
      markup = { inline_keyboard: quick.options.slice(0, 6).map((o, i) => [{ text: o.label.slice(0, 60), callback_data: `qr:${reply.id}:${i}` }]) };
    }
    if (reply.metadata_json.retryable === true) {
      markup = { inline_keyboard: MAIN_MENU };
    }
    if (leadCard?.needs_contact) {
      await conversationsRepo.setChannelState(this.opts.db, conv.id, { awaiting: 'contact', lead_id: leadCard.lead.id });
      markup = {
        keyboard: [[{ text: '📱 Share my phone number', request_contact: true }], [{ text: CANCEL_LABEL }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      };
      body += '\n\nTap “Share my phone number” below (Telegram shares only the number on your account), or type your 10-digit mobile number.';
    }
    await this.send(chatId, escapeHtml(body), markup, true);

    if (listCard) {
      if (listCard.near_match) {
        await this.send(chatId, `<i>Near match — no exact result. These are ${escapeHtml(listCard.near_match.explanation)}.</i>`, undefined, true);
      }
      for (const item of listCard.items) await this.sendListing(chatId, item, false);
      const nav: InlineButton[][] = [];
      if (listCard.total_matches > listCard.items.length) nav.push([{ text: '➕ Show more results', callback_data: 'more' }]);
      nav.push([{ text: '⭐ Compare my shortlist', callback_data: 'cmp' }, { text: '🏠 Main menu', callback_data: 'menu' }]);
      const quickRow = quick?.options.slice(0, 3).map((o, i) => ({ text: o.label.slice(0, 40), callback_data: `qr:${reply.id}:${i}` }));
      if (quickRow?.length) nav.unshift(quickRow);
      await this.send(chatId, 'Tap a listing button, or type to refine (e.g. <i>only furnished</i>, <i>under 20000</i>).', { inline_keyboard: nav }, true);
    }
    for (const card of cards) {
      if (card.type === 'property_detail') await this.sendListing(chatId, card.item, true);
    }
  }

  // ---------------------------------------------------------------------------------------
  // Output helpers

  private async sendListing(chatId: number, item: PropertyCardItem, detailed: boolean) {
    const buttons: InlineButton[][] = [
      detailed
        ? [{ text: '⭐ Save', callback_data: `s:${item.listing_code}` }]
        : [
            { text: 'ℹ️ Details', callback_data: `d:${item.listing_code}` },
            { text: '⭐ Save', callback_data: `s:${item.listing_code}` },
          ],
      [
        { text: '📞 Callback', callback_data: `cb:${item.listing_code}` },
        { text: '📍 Site visit', callback_data: `v:${item.listing_code}` },
      ],
    ];
    const caption = listingCaption(item, detailed);
    const photos = item.images.map((i) => this.resolvePhoto(i.image_url)).filter((p): p is PhotoSource => p !== null);

    if (detailed && photos.length > 1) {
      // Album first (captions/buttons are not allowed on albums), then the text card with buttons.
      try {
        const media = photos.slice(0, 10).map((p, i) => ({ type: 'photo', media: p.kind === 'url' ? p.url : `attach://photo${i}` }));
        const files = Object.fromEntries(photos.slice(0, 10).flatMap((p, i) => (p.kind === 'file' ? [[`photo${i}`, p.file]] : [])));
        await this.opts.client.call('sendMediaGroup', { chat_id: chatId, media }, { files });
      } catch (err) {
        logger.warn('telegram.media_group_failed', { status: err instanceof TelegramApiError ? err.status : 'network' });
      }
      return this.send(chatId, caption, { inline_keyboard: buttons }, true);
    }
    const photo = photos[0];
    if (photo && caption.length <= CAPTION_LIMIT) {
      try {
        await this.sendPhoto(chatId, photo, caption, { inline_keyboard: buttons });
        return;
      } catch (err) {
        // Unsupported or unreachable image: fall back to a text card.
        logger.warn('telegram.photo_failed', { status: err instanceof TelegramApiError ? err.status : 'network' });
      }
    }
    return this.send(chatId, caption, { inline_keyboard: buttons }, true);
  }

  private async sendPhoto(chatId: number, photo: PhotoSource, caption: string, markup: ReplyMarkup) {
    const cacheKey = photo.kind === 'url' ? photo.url : photo.file.filename;
    const cached = this.fileIds.get(cacheKey);
    const params = { chat_id: chatId, caption, parse_mode: 'HTML', reply_markup: markup };
    const result = await this.opts.client.call<{ photo?: { file_id: string }[] }>(
      'sendPhoto',
      { ...params, photo: cached ?? (photo.kind === 'url' ? photo.url : undefined) },
      { files: !cached && photo.kind === 'file' ? { photo: photo.file } : undefined },
    );
    const fileId = result.photo?.at(-1)?.file_id;
    if (fileId) this.fileIds.set(cacheKey, fileId);
  }

  /** Telegram cannot display SVG; site-relative SVGs use a pre-rendered PNG twin if present. */
  private resolvePhoto(url: string): PhotoSource | null {
    if (/^https:\/\//i.test(url)) return /\.svg(\?|$)/i.test(url) ? null : { kind: 'url', url };
    if (!url.startsWith('/') || url.includes('..')) return null;
    if (this.opts.publicBaseUrl?.startsWith('https://')) {
      // Deployed: Telegram fetches the PNG twin from the public site (no local files on serverless).
      return { kind: 'url', url: `${this.opts.publicBaseUrl}${url.replace(/\.svg$/i, '.png')}` };
    }
    if (!this.opts.publicDir) return null;
    const root = path.resolve(this.opts.publicDir);
    let file = path.resolve(root, `.${url}`);
    if (!file.startsWith(root + path.sep)) return null; // path traversal guard
    if (file.endsWith('.svg')) file = file.replace(/\.svg$/, '.png');
    if (!/\.(png|jpe?g|webp)$/i.test(file) || !fs.existsSync(file)) return null;
    const ext = path.extname(file).slice(1).toLowerCase();
    return {
      kind: 'file',
      file: {
        data: new Uint8Array(fs.readFileSync(file)),
        filename: path.basename(file),
        contentType: ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg',
      },
    };
  }

  /** Sends text, splitting at line boundaries to respect Telegram's 4096-character limit. */
  async send(chatId: number, text: string, markup?: ReplyMarkup, html = false): Promise<void> {
    const content = html ? text : escapeHtml(text);
    const parts = splitMessage(content, TELEGRAM_TEXT_LIMIT - 96);
    for (const [i, part] of parts.entries()) {
      await this.opts.client.call('sendMessage', {
        chat_id: chatId,
        text: part,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        ...(i === parts.length - 1 && markup ? { reply_markup: markup } : {}),
      });
    }
  }

  // ---------------------------------------------------------------------------------------

  private async conversationFor(from: TgUser, chat: TgChat): Promise<Conversation> {
    const { db } = this.opts;
    // The numeric Telegram user id is the stable identity. Username / display name are never
    // treated as verified identity or contact details.
    const customer = await customersRepo.upsert(db, 'telegram', String(from.id));
    const existing = await conversationsRepo.latestActiveForCustomer(db, customer.id);
    if (existing && existing.channel === 'telegram') {
      if (existing.external_chat_id !== String(chat.id)) {
        await db.query('UPDATE conversations SET external_chat_id = $2 WHERE id = $1', [existing.id, String(chat.id)]);
        existing.external_chat_id = String(chat.id);
      }
      return existing;
    }
    return conversationsRepo.create(db, customer.id, 'telegram', null, String(chat.id));
  }

  private async reset(conv: Conversation) {
    await this.record(conv, '/reset', 'Started a fresh search');
    await conversationsRepo.close(this.opts.db, conv.id);
  }

  /** Persists command exchanges so the admin transcript is complete. */
  private async record(conv: Conversation, inbound: string, outboundSummary: string) {
    const { db } = this.opts;
    const inMsg = await messagesRepo.insert(db, { conversation_id: conv.id, direction: 'inbound', body: inbound.slice(0, MAX_INBOUND_CHARS) });
    await messagesRepo.insert(db, {
      conversation_id: conv.id,
      direction: 'outbound',
      body: `[${outboundSummary}]`,
      metadata: { reply_to: inMsg?.id ?? null, kind: 'telegram_command' },
    });
    await conversationsRepo.touch(db, conv.id);
  }

  private allow(userId: number): boolean {
    const limit = this.opts.maxMessagesPerMinute ?? 20;
    const now = Date.now();
    const r = this.rate.get(userId);
    if (!r || now - r.windowStart > 60_000) {
      this.rate.set(userId, { windowStart: now, count: 1, warned: false });
      if (this.rate.size > 50_000) this.rate.clear();
      return true;
    }
    r.count++;
    return r.count <= limit;
  }
}

const CANCEL_LABEL = 'Cancel';

type PhotoSource = { kind: 'url'; url: string } | { kind: 'file'; file: InputFile };

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function splitMessage(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const parts: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    let l = line;
    while (l.length > limit) {
      if (current) {
        parts.push(current);
        current = '';
      }
      parts.push(l.slice(0, limit));
      l = l.slice(limit);
    }
    if ((current ? current.length + 1 : 0) + l.length > limit) {
      parts.push(current);
      current = l;
    } else current = current ? `${current}\n${l}` : l;
  }
  if (current) parts.push(current);
  return parts;
}

const STATUS_LABEL: Record<string, string> = {
  available: '🟢 Available',
  pending_confirmation: '🟡 Pending confirmation',
  unavailable: '🔴 Unavailable',
};

export function listingCaption(item: PropertyCardItem, detailed: boolean): string {
  const e = escapeHtml;
  const facts = [
    item.bedrooms !== null ? `${item.bedrooms}BHK` : null,
    humanise(item.property_type),
    item.area_sqft ? `${item.area_sqft.toLocaleString('en-IN')} sq.ft` : null,
    item.furnishing !== 'unknown' ? humanise(item.furnishing) : 'furnishing not recorded',
  ].filter(Boolean);
  const lines = [
    `<b>${item.index > 0 ? `${item.index}. ` : ''}${e(item.listing_code)}</b> · ${STATUS_LABEL[item.availability_status] ?? e(humanise(item.availability_status))}`,
    `<b>${e(item.price_label)}</b>${item.transaction_type === 'sale' ? ' · for sale' : ''}`,
    e(item.title),
    `📍 ${e(item.locality)} · ${e(facts.join(' · '))}`,
  ];
  if (item.reasons.length) lines.push(`✅ ${e(item.reasons.join(' · '))}`);
  for (const c of item.caveats) lines.push(`⚠️ ${e(c)}`);
  if (detailed) {
    lines.push(
      `🚗 Parking: ${item.parking === 'unknown' ? 'not recorded' : e(humanise(item.parking))}`,
      `🐾 Pets: ${item.pet_policy === 'unknown' ? 'not recorded' : e(humanise(item.pet_policy))}`,
      `🏢 Amenities: ${item.amenities.length ? e(item.amenities.map(humanise).join(', ')) : 'none recorded'}`,
    );
    if (item.description) lines.push(e(item.description));
  }
  lines.push(`<i>${item.is_demo ? 'Sample listing (demo data) · ' : ''}updated ${new Date(item.updated_at).toLocaleDateString('en-IN')}</i>`);
  // Not truncated here (that could cut an HTML tag); callers fall back to a text card if too long.
  return lines.join('\n');
}
