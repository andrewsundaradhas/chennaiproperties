# Implementation checklist

Status against the PRD (v1.0, 11 Oct 2026). An item is ticked only once it has been verified by the automated tests listed or by a manual run.

## Milestones

| Milestone | Status | Verified by |
|---|---|---|
| M0 Repo inspection & plan | ✅ Started from an empty folder; no existing work to preserve | — |
| M1 Foundation (workspaces, strict TS, lint, Zod env, errors, health) | ✅ | `npm run check`; `api.test.ts` (health, error format) |
| M2 Database (migrations, constraints, indexes, seed, data access, CSV) | ✅ | `search.test.ts` (seed idempotency, CSV), `api.test.ts` (persistence) |
| M3 Search engine (deterministic filters, ranking, details, no-results) | ✅ | `search.test.ts`, no AI involved |
| M4 AI orchestration (Gemini adapter, extraction, tools, context, safe errors) | ✅ mocked tests, plus a live run on `gemini-3.8-flash` (journey correct; latency and free-tier 429s noted in README) | `conversation.test.ts`, `gemini.test.ts` |
| M5 Customer web chat | ✅ | `ui.test.tsx`; headless-Chromium smoke run of the full journey at desktop and 390 px mobile (no console errors, no horizontal overflow) |
| M6 Admin dashboard (auth, CRUD, filters, leads) | ✅ | `api.test.ts`, `ui.test.tsx` |
| M7 Hardening (rate limits, validation, logs, isolation, failure tests) | ✅ | `api.test.ts`, `conversation.test.ts` |
| M8 Handover (README, .env.example, commands, demo script, limitations) | ✅ | README |

## Acceptance scenarios (PRD §11.1)

| ID | Scenario | Test |
|---|---|---|
| AC-01 | "2BHK for rent in Velachery under ₹25,000" | `search.test.ts` › AC-01 · `conversation.test.ts` › AC-01 |
| AC-02 | "Only furnished ones" keeps other preferences | `conversation.test.ts` › AC-02 · `unit.test.ts` merge |
| AC-03 | Budget change keeps location/type/BHK | `conversation.test.ts` › AC-03 · `unit.test.ts` merge |
| AC-04 | Unknown pet policy → "not recorded" | `conversation.test.ts` › AC-04 |
| AC-05 | No match → no fake result, controlled relaxation | `search.test.ts` › AC-05 · `conversation.test.ts` › AC-05 |
| AC-06 | "the second one" resolves to the current result set | `conversation.test.ts` › AC-06 |
| AC-07 | Callback persists a lead with the right property | `conversation.test.ts` › AC-07 |
| AC-08 | Site visit recorded as requested, not confirmed | `conversation.test.ts` › AC-08 · `api.test.ts` leads |
| AC-09 | Deactivated listing leaves search; lead link survives | `search.test.ts` · `api.test.ts` › AC-09 |
| AC-10 | Restart → data persists | `api.test.ts` › AC-10 (file-backed DB closed and reopened) |
| AC-11 | Provider timeout / invalid output → safe response | `conversation.test.ts` › AC-11 · `gemini.test.ts` |
| AC-12 | Unauthenticated admin call rejected | `api.test.ts` › AC-12 |
| AC-13 | Sessions isolated | `conversation.test.ts` › AC-13 · `api.test.ts` › AC-13 |
| AC-14 | Seed twice → no duplicates | `search.test.ts` › AC-14 (plus manual CLI run: 36 inserted, then 0) |
| AC-15 | Duplicate request with idempotency key | `conversation.test.ts` › AC-15 · `api.test.ts` › AC-15 and leads |

## Requirement coverage

- **CHAT-01..10:** all implemented. CHAT-09 (Tamil/English) works fully only with Gemini; rule mode detects Tanglish and keeps the requirements.
- **PROP-01..07:** all implemented. Photos are URLs (no upload). Missing images show a placeholder.
- **LEAD-01..06:** all implemented, including notes, assignment and the audited conversation view.
- **§4.5 reliability:** DB is the source of truth; migrations and seed are reproducible; duplicate message and lead IDs are handled; validation at every boundary; request IDs; health endpoint.
- **§10 security:** server-side secrets, hashed tokens and passwords, rate limits, body-size limit, CORS allowlist, session ownership, no internal fields in public responses, generic 500s.

## Open items / next steps

1. Get a Gemini quota that supports more than a few turns per minute, then review Tamil/Tanglish transcripts (the rephrase path was rate limited during the live test).
2. Business sign-off on the product name, UI copy and FAQ answers (`business_faqs` is seeded with demo text).
3. Replace demo inventory with approved listings (CSV import), then `db:reset-demo` is no longer used.
4. Move admin auth to a managed provider before any real customer data.
5. Hosted deployment (PRD §13.3), then the WhatsApp adapter ([whatsapp-adapter.md](whatsapp-adapter.md)).
