# CLAUDE.md

## What this is

Turikumwe — a household + apartment-hunt assistant for a couple (Felipe &
Lucía) in Bogotá. A Telegram group is the only input: plain messages become
tracked household items (Claude parses them into ops), listing URLs become
scraped + extracted apartments, photos and realtor PDFs attach to
apartments, visits are first-class rows (follow-ups included, with who went
and how it went), due-diligence documents are tracked per apartment, crons
post a morning digest / evening nudges / visit reminders, and two
Cloudflare-Access-protected web screens (`/dashboard.html`,
`/apartments.html`) mirror the data. An MCP endpoint (`POST /mcp`, bearer
token) lets Claude clients ask open-ended questions via read-only SQL; its
only write is adding an apartment note. Everything user-facing is in
**Spanish**.

## Status

Live: Worker `household` at https://turikumwe.cc (custom domain — Access can't
cover `*.workers.dev`), remote D1 `household` migrated, secrets set
(`BOT_TOKEN`, `TG_WEBHOOK_SECRET`, `ANTHROPIC_API_KEY`), Telegram webhook
registered, Access apps configured (webhook bypass + OTP-gated web UI),
Email Routing on the zone for calendar invites. The MCP endpoint needs a
one-time setup before its first deploy: `wrangler secret put MCP_TOKEN` and
an Access Bypass application on the `mcp` path (README §5–6).

There are no tests: verification = `npx tsc --noEmit` + reading the diff;
real verification happens in the Telegram group after `npm run deploy`.

- `npm run dev` — web screens on localhost:8787, local D1 seeded from
  `schema.sql` + `seed.sql` automatically, Access faked via `--var DEV_USER`.
  Preview it through `.claude/launch.json` (`household-worker`) — works the
  same locally and in Claude Code web. See ARCHITECTURE.md §9.
- `npm run typecheck` — `tsc --noEmit`
- `npm run deploy` — `wrangler deploy` (does NOT run migrations — see below)

## Architecture

**`ARCHITECTURE.md` is the gold standard for this repo** — data flow,
directory map, route table, data model, cron behavior, migration discipline.
Read it before structural work. **Every change that alters anything it
describes MUST update it in the same change** — code and doc disagreeing
means the change is incomplete.

## Stack (decided, don't re-litigate)

- One Cloudflare Worker, **one file of logic** (`src/index.ts`) — no framework,
  no router lib, no build step beyond wrangler. Plain `fetch`/`scheduled` handlers.
- D1 via raw SQL through three helpers (`all`/`get`/`run`) — no ORM, no migration tool
- Web screens are self-contained HTML files imported as text (`src/*.html`,
  wrangler's built-in Text rule) with `{{PLACEHOLDER}}` substitution — no SPA, no bundler
- Telegram Bot API by raw `fetch`; legacy Markdown parse mode with plain-text fallback
- Anthropic API by raw `fetch` (`claude()` in index.ts), model `claude-sonnet-5`
- Auth: Cloudflare Access (OTP) for the web, secret-token header for the webhook,
  `GROUP_CHAT_ID` check for Telegram — no user accounts, no sessions
- Geocoding: OSM/Overpass street-grid crossing lookup, keyless, cached in the row
- Calendar invites: iCalendar over the `send_email` Email Routing binding — no mail API keys

## Decisions that are easy to get wrong

- **Schema migrations are manual `ALTER TABLE` commands run BEFORE deploy.**
  `schema.sql` is `CREATE TABLE IF NOT EXISTS` — re-applying it never adds
  columns to an existing table. New column → add it to `schema.sql` AND
  document the one-off `ALTER` in ARCHITECTURE.md §6. New table → re-applying
  `schema.sql` suffices.
- **The webhook acks instantly; all work runs in `ctx.waitUntil`.** Telegram
  retries non-200 responses — slow scrape/Claude work inside the request
  body would duplicate every message.
- **Interpolated free text in Telegram messages must go through
  `mdEscape`/`mdLink`.** Legacy Markdown silently corrupts text with `_`/`*`;
  raw URLs never go bare in message text. Links belong in inline url buttons
  when possible (buttons never touch the parser).
- **Shared mutations have ONE implementation.** `ruleOutApt` / `reactivateApt`
  / `appendAptNote` / `upsertVote` / `setVisit` / `addVisit` / `editVisit` /
  `setDoc` serve the Telegram ops loop, the callback buttons, the
  photo/document handlers, the web actions (and MCP for notes). Each returns
  the post-mutation state — don't re-read it, don't fork a second path. Their
  group announcements are built ONLY by `aptAnnounce` (it owns the emoji,
  `aptRef` escaping, and the keyboard); the invite/cancel mail decision
  (`visitMail`) lives inside the visit mutations. `setVisit` = the NEXT
  upcoming visit (create/move/cancel); `addVisit` = always a new follow-up
  row; `editVisit` = one visit row by id. A visit's "hecha" state is derived
  (non-cancelled + past), never stored.
- **Telegram ops have ONE vocabulary.** `OP_LINES` drives both the parser
  prompt and `executeOps`' dispatch; a malformed or unimplemented op is acked
  «no entendí», never dropped silently. New op → one `OP_LINES` entry + one
  `executeOps` branch.
- **Some logic is deliberately twinned across server and web page** —
  `mapsLink`/`waLink`, the $/m² math, `priceAreaBits` (all-in monthly
  for rent), and the visit end-of-day padding (`visitCmpJs`/`visitCmpSql` ↔
  the page's `visitCmp`, which also derives the pending/scheduled/visited
  stage) exist in both `index.ts` and `apartments.html`. Change one →
  change the other (the comments say so).
- **All times are Bogota wall-clock strings** (`YYYY-MM-DD` or
  `YYYY-MM-DDTHH:MM`), string-comparable, no DST (UTC-5 fixed). Date math is
  Z-anchored on purpose — don't "fix" it with real timezone handling.
- **Failures are visible, not silent.** A blocked scrape still saves the row
  (`scrape_status`), a Claude parse error tells the group to resend, a mail
  hiccup appends a warning to the ack. Keep it that way.
- **Answer Telegram callback queries BEFORE slow work** — a late
  `answerCallbackQuery` is silently rejected and the button spins forever.
- **Cron strings are triplicated**: `wrangler.toml [triggers]`, the
  `scheduled()` switch, and the comment. Keep all three in sync.
