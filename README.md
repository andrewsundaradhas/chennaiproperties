# ChennaiProperties AI — property assistant prototype

A local-first, AI-assisted property discovery and lead-management prototype. Customers describe what they want in a web chat ("2BHK for rent in Velachery under ₹25,000 with parking"). The system turns that into validated filters, searches **only the stored inventory**, answers listing questions from stored fields, and records callback and site-visit **requests**. Staff manage listings and leads in an authenticated dashboard.

> **Demo data:** every seeded listing (`CP-DEMO-001` … `CP-DEMO-036`) is invented sample data. It is flagged `is_demo = true` and labelled "Sample data" in the UI. It is not ChennaiProperties inventory.
>
> **Channels:** web chat and Telegram are live (see [Telegram bot](#telegram-bot)). **WhatsApp is deferred.** No number is connected or registered. See [docs/whatsapp-adapter.md](docs/whatsapp-adapter.md).

---

## Quick start

Requirements: **Node.js ≥ 20.19** (developed on Node 26). Docker and a PostgreSQL install are not needed.

```bash
npm run setup                                       # creates .env, installs, migrates, seeds demo data
npm run admin:create -- --email you@example.com     # prints a generated password once
npm run dev                                         # API on :4000, web on :5173
```

Open:

- Customer chat: http://localhost:5173
- Staff dashboard: http://localhost:5173/admin

It runs with **no API keys**. Without `GEMINI_API_KEY`, a deterministic rule-based interpreter handles the conversation. See [Enabling Gemini](#enabling-gemini).

### Demo script (about 3 minutes)

1. In the chat, type: `2BHK in Velachery under 25k`. The assistant asks **rent or buy?** first and won't guess. Click **Rent**.
2. `Only furnished ones.` adds the furnishing filter. Location, BHK and budget are kept (see the "Searching:" chips).
3. `Actually my budget is ₹30,000.` changes only the budget.
4. `Does CP-DEMO-005 allow pets?` gets "The pet policy isn't recorded…" because the listing has no recorded policy, so nothing is invented.
5. `Does the second one allow pets?` resolves "second" against the results currently on screen.
6. `compare 1 and 2`, then `show cheaper ones`.
7. Click **Visit** on a card, or type `I'd like to visit the first one on Saturday at 11am`. The request is recorded as *visit requested* and is **not confirmed**. Fill in the contact form.
8. `5BHK villa for rent in Velachery under 10k` gets no fake results and suggests specific relaxations.
9. In `/admin`: the overview counts come from the database. Open **Leads**, open the new lead (requirements, listing and transcript), set the status to *contacted* and assign an agent.
10. Go to **Properties**, deactivate the listing you asked about, and repeat the search in the chat. It's gone, and the lead still links to it.

---

## Architecture

```
Customer web chat ─┐                       ┌─> AI provider (Gemini, or rule-based) — INTERPRET only
 (future WhatsApp) ┴─> Express API ─> Conversation service ─┤
                                           ├─> Requirement merge + validation (Zod)
                                           ├─> Property search (deterministic SQL + ranking) ─┐
                                           ├─> Lead / shortlist services ─────────────────────┼─> PostgreSQL
                                           └─> Message persistence ───────────────────────────┘   (PGlite locally)
React admin dashboard ──> /api/admin (cookie session, scrypt passwords, audit log)
```

**How a chat turn works** ([server/src/services/conversation.service.ts](server/src/services/conversation.service.ts)):

1. **Persist** the customer message first, so a provider failure never loses it. A repeated `client_message_id` returns the original reply.
2. **Interpret.** The model returns a JSON *plan*: intent, requirement changes (`set`/`clear`), references such as "the second one", and contact details. The plan contains **no property facts**, and it is validated against a Zod schema ([server/src/ai/schemas.ts](server/src/ai/schemas.ts)). An unknown intent or invalid JSON is rejected.
3. **Execute** deterministic backend tools: `save_requirements` (merge), `search_properties`, `get_property_details`, `shortlist_property`, `create_lead`, `get_business_faq`. The model never writes SQL and never touches the database.
4. **Draft** a reply from the tool results only. Unknown fields come out as "not recorded". Pending listings are marked unconfirmed, and visits are always "requested, not confirmed".
5. **Optional rephrase / translation** by the model. A grounding guard ([server/src/ai/guard.ts](server/src/ai/guard.ts)) **discards** any rewrite that introduces a listing code, a number or a booking claim the draft didn't contain.
6. **Persist** the reply along with its structured result cards.

If Gemini fails (timeout, rate limit, invalid output), the turn falls back to the rule-based interpreter. If that can't understand the message either, the customer gets a safe "please try again" and the server stays up.

| Layer | Location |
|---|---|
| Config (Zod-validated env) | `server/src/config/env.ts` |
| DB client (PGlite or `pg`), migrations, seed | `server/src/db/` |
| Domain: enums, localities/aliases, requirements merge, formatting | `server/src/domain/` |
| Repositories (parameterised SQL only) | `server/src/repositories/` |
| Services: search, conversation, leads, property admin, CSV import | `server/src/services/` |
| AI adapters: Gemini, rules, prompts, guard | `server/src/ai/` |
| Channel adapters: web (active), WhatsApp (boundary only) | `server/src/channels/` |
| HTTP: routes, auth, rate limits, errors | `server/src/http/` |
| Frontend: chat + admin | `web/src/` |

### Key decisions

- **Database:** with `DATABASE_URL` empty (the default), the API uses **[PGlite](https://pglite.dev)**, which is real PostgreSQL compiled to WASM, persisted in `server/data/pgdata`. Nothing needs installing. Set `DATABASE_URL` to use any PostgreSQL or Supabase database. The same SQL migrations run on both. PGlite is single-process, so a lockfile stops scripts from opening it while the dev server is running.
- **Search is deterministic:** hard filters (transaction type, status, budget, BHK, type, furnishing, locality) run in SQL. Unknown parking or pet values are **kept but flagged**; only a confirmed "no" excludes a listing. Corridors (OMR, ECR, GST Road) expand to their localities but rank below exact locality matches. When nothing matches, the backend tries one relaxation at a time (budget +15%, any furnishing, ±1 BHK, nearby area) and labels the result clearly as a near match.
- **Listings are never deleted:** deactivation keeps lead history intact (the `leads.property_id` foreign key is `RESTRICT`).
- **Admin auth:** local accounts with scrypt-hashed passwords. Sessions are random tokens stored hashed in the DB, in an httpOnly, SameSite=Lax cookie. Admin mutations must be JSON, which blocks cross-site form posts. For production, swap in managed auth (e.g. Supabase Auth). `admin_users` already has `auth_provider` / `auth_provider_id` columns.
- **Customer sessions:** anonymous bearer tokens (stored hashed). History is returned only to the token holder; a wrong token gets a 404.

---

## Telegram bot

Customers can use the assistant on Telegram as well as the web chat. The Telegram adapter (`server/src/channels/telegram/`) only translates messages and buttons. Everything else is the **same code the web chat uses**: Gemini interpretation and the rule-based fallback, deterministic database search, requirement memory, the grounding guard, shortlists and leads. Telegram enquiries appear in the dashboard with a **Telegram** badge.

### 1. Create a bot and add the token
1. In Telegram, open **@BotFather** and send `/newbot`. Choose a name and a username ending in `bot`.
2. Copy the token (`123456789:AA…`) into `.env`:
   ```
   TELEGRAM_BOT_TOKEN=123456789:AA...
   ```
   Never put it in source code. `.env` is gitignored, and `npm run check:secrets` blocks accidental commits.

### 2. Run it
```bash
npm run dev        # starts the database connection, API, web app AND the Telegram bot (long polling)
```
The bot runs **inside the API process**, so there's no extra command and no chance of two pollers from one checkout. The embedded database is single-process, so a separate process wouldn't work locally anyway. On startup the log shows `telegram.polling_started {"username":"your_bot"}`, and the dashboard **Overview** shows "Telegram bot is live as @…". Without a token the log shows `telegram.disabled` with setup instructions, and everything else runs normally.

### 3. Test it
Open `https://t.me/<your_bot_username>` from your own Telegram account:

| Try | Expected |
|---|---|
| `/start` | Welcome text, demo-data notice, main-menu buttons |
| `Find a 2BHK for rent in Velachery under 25000` | Header text, then one photo card per listing with **Details / Save / Callback / Site visit** buttons |
| `Show me furnished properties`, then `actually my budget is 30000` | Search refined; location and BHK kept |
| `Does CP-DEMO-005 allow pets?` | "The pet policy isn't recorded…" |
| Tap **⭐ Save** on two listings, then **Compare my shortlist** | Side-by-side comparison |
| Tap **📞 Callback** | Lead recorded. A **Share my phone number** button appears (Telegram shares only your own verified number) |
| `I want to visit the first one this weekend` | Site-visit **request** recorded, explicitly not confirmed |
| `/reset` → **Yes, start fresh** | New search context. Past leads and messages are kept |
| Dashboard → **Leads** | The enquiry, with a Telegram badge, the listing, the phone and the transcript |

Commands: `/start`, `/properties`, `/help`, `/reset`, `/cancel`. They're registered with Telegram automatically, so they appear in the bot's menu.

### 4. Stop it safely
Press `Ctrl+C` in the `npm run dev` terminal. The poller aborts its long poll, finishes in-flight messages and releases its lease.

### How it stays safe and consistent
- **Identity:** the numeric Telegram user ID is the identity; replies go to the chat ID. Usernames and display names are never treated as verified identity or contact details. Phone numbers come only from the user typing them, or from Telegram's contact-share of **their own** account (forwarded contacts are rejected). Telegram and web customers are separate records.
- **Duplicates:** each `update_id` is processed once (`telegram_updates` table, which survives restarts). Message and lead creation are idempotent too.
- **One consumer per bot:** a database lease plus Telegram's own `409 Conflict`. A second instance waits on standby.
- **Buttons are validated server-side.** Callback data carries only a listing code or a short action. Every listing is re-read from the database and must be active. Quick-reply buttons resolve only against the user's own messages. Customers have no admin actions.
- **Button taps skip the AI** (fast and free). Typed messages go through Gemini, falling back to rules if Gemini fails.
- **Reliability:** per-user rate limit (`TELEGRAM_MAX_MESSAGES_PER_MINUTE`), bounded retries with `retry_after` for 429/5xx, 2,000-character inbound cap, long replies split under Telegram's 4,096-character limit, graceful fallback to text when a photo can't be sent. Non-text media gets a polite "text only" reply.
- **Photos:** Telegram can't show SVG, so the demo images have PNG twins (`web/public/demo-images/*.png`). Remote `https://` image URLs are sent as-is. Uploaded photos are cached by Telegram `file_id`.
- **Logs never contain the token.** Errors are redacted, and network errors never echo the request URL.

### Troubleshooting
| Symptom | Fix |
|---|---|
| `telegram.disabled … not in the expected format` | Re-copy the full token from @BotFather (`digits:letters`) |
| `telegram.start_failed … rejected by Telegram` | The token is wrong or was revoked. Use `/token` or `/revoke` in @BotFather and update `.env` |
| `telegram.start_failed … Could not reach Telegram` | Network or firewall issue. Check `curl https://api.telegram.org`, then restart |
| `telegram.lease_held_elsewhere` / Overview says "standby" | Another process is polling this bot (another terminal or machine). Stop it. A crashed process's lease expires within 90 s |
| `telegram.polling_conflict` (409) | Some other program is calling `getUpdates` with this token, or a webhook is set. Stop it, or run `npm run telegram:webhook -- --delete` |
| `A webhook is configured…` | `npm run telegram:webhook -- --delete`, then restart |
| Bot doesn't answer in a group | By design: it only serves private chats |
| Replies are slow or "simpler" | Gemini latency or rate limit. The rule-based fallback answers instead (see Known limitations) |

### Production webhook (later)
Polling is for local development. For a deployed API with HTTPS:
1. Set `TELEGRAM_MODE=webhook` and `TELEGRAM_WEBHOOK_SECRET=<16+ random chars>` on the server.
2. `npm run telegram:webhook -- --url https://<your-api>/api/telegram/webhook` registers it with that secret. Check it with `npm run telegram:webhook -- --info`.
3. Telegram then POSTs updates to `/api/telegram/webhook`. Requests without the secret header are rejected with 401. Updates are acknowledged immediately and processed asynchronously through the same `handleUpdate()` path, with the same dedupe.
4. To go back to local polling: `npm run telegram:webhook -- --delete`.

---

## Deploy to Vercel (chat + admin dashboard + Telegram)

One Vercel project serves everything:
- **Static site** (`web/dist`): customer chat at `/`, staff dashboard at `/admin`. Served by Vercel's CDN with SPA fallback.
- **One serverless function** (`api/index.js` → `server/dist/serverless.js`): every `/api/*` route, including the Telegram webhook. It reuses the Express app per warm instance.
- **Supabase** stays the database. The embedded database is never used on Vercel; startup fails clearly if `DATABASE_URL` is missing.

All of this is configured in [vercel.json](vercel.json), so the Vercel UI needs no build settings.

### Before the first deploy
1. **Migrations** are not run by the function. Apply them from your Mac: `npm run db:migrate` (already done for the current Supabase project).
2. **Push to a private GitHub repo.** `npm run check:secrets` must pass. `.env`, `server/data/` and `.vercel/` are gitignored, and `.vercelignore` covers CLI uploads.
3. **Use a strong admin password**, because the dashboard becomes public: `ADMIN_PASSWORD='<long random>' npm run admin:create -- --email admin@example.com`.

### Create the project
Vercel → **Add New → Project** → import the GitHub repo. Leave the framework as **Other**; everything else comes from `vercel.json`. Under **Environment Variables** (Production) add:

| Variable | Value |
|---|---|
| `DATABASE_URL` | Supabase **Transaction pooler** string (port **6543**): `postgresql://postgres.<ref>:<url-encoded-password>@aws-0-<region>.pooler.supabase.com:6543/postgres` |
| `GEMINI_API_KEY` | your key |
| `GEMINI_MODEL` | `gemini-3.8-flash` |
| `TELEGRAM_BOT_TOKEN` | your bot token |
| `TELEGRAM_WEBHOOK_SECRET` | same value as in your local `.env` (random, 16+ chars) |
| `COOKIE_SECURE` | `true` |

Detected automatically on Vercel, so you don't need to set them: `APP_ORIGIN` and `PUBLIC_BASE_URL` (from the production URL), `TELEGRAM_MODE=webhook`, and `DB_POOL_MAX=2`. Set `APP_ORIGIN` and `PUBLIC_BASE_URL` yourself only if you use a custom domain.

Click **Deploy**, then open `https://<project>.vercel.app` (chat) and `/admin` (dashboard). The Overview should say *Telegram bot is live … (webhook)*.

### Point Telegram at Vercel
From your Mac, with the same token and secret in `.env`:
```bash
npm run telegram:webhook -- --url https://<project>.vercel.app/api/telegram/webhook
npm run telegram:webhook -- --info        # shows the URL and any delivery errors
```
- On Vercel, each webhook update is **fully processed before the function responds**, because serverless instances may be frozen afterwards. `maxDuration` is 60 s. Retries are harmless because updates are de-duplicated.
- Listing photos are sent as public URLs of the PNG demo images on your deployment.
- Use the **production** URL. Vercel's Deployment Protection blocks Telegram from reaching protected preview URLs.
- **One bot token = one mode.** Once the webhook is set, local `npm run dev` won't poll that bot (the log says a webhook is configured). For local development, create a second bot in @BotFather and put its token in your local `.env`, or run `npm run telegram:webhook -- --delete` to take the bot back to local polling.

### Production notes
- Rate limits are per serverless instance (in memory). That's adequate for a pilot; use a shared store before heavy public traffic.
- Each cold start makes one `getMe` call to Telegram and opens up to 2 database connections through the transaction pooler.
- Logs are in Vercel → Project → Logs. They are the same structured JSON as locally, and never include secrets.
- Rollback: Vercel → Deployments → promote a previous deployment. The database is unaffected.

---

## Commands

| Command | What it does |
|---|---|
| `npm run setup` | One-time setup: `.env`, install, migrate, seed |
| `npm run dev` | API (tsx watch, :4000) + Vite (:5173, proxies `/api`) |
| `npm run db:migrate` | Apply pending SQL migrations (`server/src/db/migrations`) |
| `npm run db:seed` | Insert demo listings. Safe to re-run: existing codes are left untouched |
| `npm run db:reset-demo -- --yes` | Delete all customers/chats/leads and demo listings, then re-seed. Keeps manual/imported listings |
| `npm run admin:create -- --email x@y.z [--name N] [--role admin\|agent]` | Create an admin or reset their password. Uses `ADMIN_PASSWORD` (≥12 chars) if set, otherwise prints a generated one |
| `npm run import:csv -- file.csv [--commit]` | Validate (dry run by default), then import listings. All-or-nothing |
| `npm test` | Server (Vitest + Supertest, in-memory PGlite) and web (Vitest + Testing Library) tests |
| `npm run telegram:webhook -- --url URL \| --delete \| --info` | Manage the production Telegram webhook |
| `npm run check:secrets` | Scans every file git would commit for keys, tokens and passwords in DB URLs |
| `npm run typecheck` / `npm run lint` / `npm run check` | Types / ESLint / secrets + types + lint + tests |
| `npm run build` && `NODE_ENV=production npm start` | Compiled API that also serves `web/dist` on one port (non-Vercel hosting) |

Stop `npm run dev` before running `db:*`, `admin:create` or `import:csv` against the embedded database.

### CSV import

Columns: `listing_code, title, transaction_type, property_type, locality, price_amount, price_period` (required), plus optional `address_public, bedrooms, bathrooms, area_sqft, furnishing, amenities, parking, pet_policy, availability_status, description, image_urls`. Separate list values with `|`. See [docs/sample-import.csv](docs/sample-import.csv). Imports run from **Properties → Import CSV** in the dashboard or from the CLI. If any row is invalid or duplicates an existing code, **nothing** is imported and every row error is reported.

---

## Environment variables

See [.env.example](.env.example). Only these are used:

| Variable | Default | Notes |
|---|---|---|
| `PORT` | 4000 | API port |
| `APP_ORIGIN` | http://localhost:5173 | The only origin allowed by CORS |
| `LOG_LEVEL` | info | `debug`/`info`/`warn`/`error`/`silent`. Logs never include message bodies or keys |
| `AI_PROVIDER` | auto | `gemini` or `rules`. Auto picks `gemini` when a key is set |
| `GEMINI_API_KEY` | — | Server-side only, sent in a header and never in URLs or logs |
| `GEMINI_MODEL` | — | Required with Gemini. Deliberately not hard-coded |
| `GEMINI_TIMEOUT_MS` | 20000 | Per-request timeout. Up to 3 attempts on 5xx/timeouts. 429s are not retried; the turn falls back to rules |
| `GEMINI_THINKING_LEVEL` | low | `low`/`high`/`none`. Gemini 3.x thinks by default, which adds seconds per turn |
| `GEMINI_COMPOSE` | non_english | When the model rephrases the grounded draft: `non_english`/`always`/`never`. English drafts are used as-is, so a turn is one model call |
| `DATABASE_URL` | — | Empty means embedded PGlite. Set it for Postgres/Supabase |
| `PGLITE_DATA_DIR` | ./data/pgdata | Relative to `server/` |
| `ADMIN_BOOTSTRAP_EMAIL` | — | Default email for `admin:create` |
| `COOKIE_SECURE` | false | Set to `true` behind HTTPS |

Nothing reaches the browser bundle: the frontend reads no environment variables. To verify after a build: `grep -riE 'GEMINI|DATABASE_URL|api_key' web/dist` should print nothing.

### Enabling Gemini

```bash
# .env
GEMINI_API_KEY=your-key
GEMINI_MODEL=gemini-3.8-flash   # older models (e.g. 2.5) are closed to new keys
```

Restart `npm run dev`. The startup log shows `"ai":"gemini"`. Gemini adds broader phrasing coverage and Tamil/Tanglish replies (CHAT-09). Every property fact still comes from the database. Review Google's current data-use terms before sending real customer conversations.

### Using PostgreSQL / Supabase

To use Supabase, set `DATABASE_URL` in `.env` (never commit it).

- Use the **Session pooler** string from Supabase → Connect, e.g.
  `postgresql://postgres.<ref>:<url-encoded-password>@aws-0-<region>.pooler.supabase.com:5432/postgres`.
  The direct `db.<ref>.supabase.co` host is **IPv6-only** and times out on IPv4-only networks.
- Percent-encode special characters in the password (`@` → `%40`).
- TLS is on by default for remote hosts (`DATABASE_SSL=require`). For full certificate verification, download Supabase's CA certificate (Project Settings → Database → SSL) and set `DATABASE_SSL=verify` and `DATABASE_SSL_CA=/path/to/prod-ca-2021.crt`.
- Migration `002_enable_rls.sql` enables Row Level Security on every table with no policies. Supabase's REST API therefore returns nothing to the anon/publishable key, while the Express server (the table owner) is unaffected. Verified: `GET /rest/v1/properties` with the publishable key returns `[]`.
- Migration `003_revoke_api_roles.sql` also removes every privilege from the `anon`/`authenticated` roles, including on future tables (RLS does not cover `TRUNCATE`). REST calls with the publishable key now fail with `42501 permission denied`.
- `@supabase/supabase-js` and the publishable key are not used. All database access is server-side.
- Setup on a new project: `npm run db:migrate && npm run db:seed && npm run admin:create -- --email you@example.com`.
- Tests always use an in-memory database and never touch Supabase.
- To switch back to the embedded database, empty `DATABASE_URL` in `.env`.

---

## Tests

`npm test` runs 139 tests:

- **Unit:** requirement schema and merge semantics, locality aliases and corridors, price formatting, amount parsing, rule-based interpretation, the grounding guard, demo-data edge cases, property validation.
- **Service:** search eligibility and ranking, unknown-value handling, near matches, live effect of edits and deactivation, seed idempotency, all-or-nothing CSV import.
- **Conversation (AI mocked):** the full PRD journey, provider timeout and fallback, invalid or unknown-tool output, fabricated rewrites rejected, duplicate message IDs.
- **Gemini adapter:** header auth, bounded retries, no retry on auth errors, invalid JSON, timeouts.
- **API:** validation, the common error format, session isolation, admin auth boundaries, CSRF hardening, CRUD, pagination, lead updates with audit, CSV import, rate limiting, **persistence across restart** (file-backed DB is closed and reopened).
- **Telegram (mocked Bot API, no real credentials):** commands, rental and sale search, multi-message refinement, buttons and callback validation, photo cards and caching, details with unknown facts, no results, shortlist and compare, callback leads with contact sharing, unconfirmed site visits, duplicate updates, two-user isolation, rate limiting, retries and 429 handling, token redaction in logs, missing, malformed or revoked tokens, webhook secret, polling lease and offset, restart persistence, Vercel mode (env defaults, process-before-ack webhook, public photo URLs, clean 503 when misconfigured).
- **UI:** chat send/receive, result cards, loading and double-send prevention, error with retry, zero results, contact-form validation, admin login gate, overview counts, property-form validation, lead status update.

PRD acceptance scenario → test mapping is in [docs/IMPLEMENTATION.md](docs/IMPLEMENTATION.md).

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `The embedded database … is in use by another process` | Stop `npm run dev` before running DB scripts. If no process is running, delete `server/data/pgdata/.cp-process.lock` |
| Chat says "couldn't process that just now" | Check API logs for `ai.interpret_failed` (category: timeout / rate_limited / config / invalid_output). A `config` category means the key or model is wrong |
| `Invalid environment configuration` at startup | The message names the variable, e.g. `AI_PROVIDER=gemini requires GEMINI_API_KEY and GEMINI_MODEL` |
| Admin login fails | Run `npm run admin:create -- --email you@example.com` again to reset the password |
| Chat loads empty after a reset | Expected: the old session was deleted and a new one was created automatically |
| `vite http proxy error … ECONNREFUSED` right after `npm run dev` | The API is still starting; it resolves within a second or two |
| Start completely fresh | Stop the servers, delete `server/data/`, run `npm run db:migrate && npm run db:seed` |

---

## Known limitations (prototype)

- **Rule-based mode** covers common English phrasings and a little Tanglish. Unusual phrasing gets a clarifying question.
- **Gemini mode (tested live on 12 Oct 2026 with `gemini-3.8-flash`)** interpreted the PRD journey correctly. Two caveats: turns took **4–22 s**, partly because Google reported high demand at the time; and a **free-tier key hits 429 rate limits within a few turns**. When rate limited, the turn falls back to rules, which stays safe but loses phrasing coverage. A paid tier, or a lighter model such as `gemini-3.1-flash-lite`, is advisable for a live pilot. The Tamil rephrasing path has not been exercised live because of the rate limit.
- **No booking system:** visits are only ever *requested*. Staff confirm outside the system.
- **Rate limits are in-memory** and per process. Use a shared store (e.g. Redis) when scaling out.
- **Admin auth is local** (email + password). Move to managed auth (Supabase Auth/SSO) before production. There is one role level; `agent` exists but has the same access.
- **No image upload:** listings take image URLs. The demo images are original placeholder illustrations.
- **Tamil support** depends on the model. The rule-based interpreter only detects it.
- Not a legal or privacy review. Before launch: confirm DPDP Act obligations, consent and retention policy, listing permissions and Gemini data terms (PRD §10.3 and Appendix C).
