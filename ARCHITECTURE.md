# ARCHITECTURE.md — Turikumwe (household + apartment-hunt Worker)

**This file is the gold standard for how this repo is built.** If a change
alters anything described here — a table, route, cron, binding, or invariant —
updating this document is part of that change, not a follow-up. Code and this
file disagreeing means the change is incomplete.

## 1. System overview

One Cloudflare Worker (`household`, https://turikumwe.cc). A Telegram group is
the only input surface: plain messages are parsed by Claude into household
ops, listing URLs are scraped and extracted into apartment rows, photos attach
to apartments, inline buttons drive one-tap actions. Crons push a morning
digest, evening nudges, and visit reminders back into the group. Two
Access-protected web screens mirror the data. All user-facing text is Spanish.

```
Telegram group ──POST /telegram-webhook (secret header)──┐
Web UI (Cloudflare Access, OTP) ──GET/POST routes────────┤
MCP clients ──POST /mcp (bearer token)───────────────────┤
Crons (3 schedules) ──scheduled()────────────────────────┤
                                                         ▼
                       Worker «household» — src/index.ts (ALL logic)
                         ├─ env.DB                → D1 «household» (raw SQL, schema.sql)
                         ├─ env.BOT_TOKEN         → Telegram Bot API (send, callbacks, getFile)
                         ├─ env.ANTHROPIC_API_KEY → Claude (claude-sonnet-5): ops parser + listing extractor
                         ├─ env.INVITE_MAIL       → Email Routing send_email binding (iCalendar invites)
                         └─ fetch                 → listing pages (scrape) + Overpass/OSM (geocode)
```

No framework, no router, no bundler, no ORM, no npm runtime dependencies —
wrangler + typescript only. HTML screens are static files imported as text.

## 2. Invariants (the rules that matter)

1. **Webhook acks instantly.** `POST /telegram-webhook` validates the
   `X-Telegram-Bot-Api-Secret-Token` header, then runs `handleUpdate` inside
   `ctx.waitUntil` and returns `ok` immediately — otherwise Telegram retries
   and duplicates every message. Messages from any chat other than
   `GROUP_CHAT_ID` are dropped.
2. **One implementation per mutation.** Rule-out, reactivate, notes, and
   votes (`ruleOutApt`, `reactivateApt`, `appendAptNote`, `upsertVote`) are
   shared by all three entry points: Claude-parsed ops, inline-button
   callbacks, and web actions. Concurrency/idempotency lives there too — a
   status predicate on the `UPDATE` plus a `meta.changes` check means only
   the tap that actually flips the row announces; stale taps answer "ya
   estaba hecho". The invite/cancel mail decision (`visitMail`) is separate
   and fires only on an explicit `visit_date` change — rule-out and
   reactivate deliberately never call it, so discarding an apartment never
   touches its calendar invite; only a person editing the visit date does.
3. **Telegram Markdown is legacy mode and hostile.** Free text (addresses,
   names, scraped titles/URLs) is interpolated only through `mdEscape`;
   links through `mdLink`; raw URLs never go bare in text. `tgSend` retries
   plain-text on parse rejection, then without the keyboard. Prefer url
   buttons for links — buttons bypass the parser entirely.
4. **Callback queries are answered before slow work** (`rs:` rescrape can run
   15 s; a late answer is silently rejected and the button spins forever).
   Callback data is a server-minted `verb:id` (`ro|re|rs|up|dn`).
5. **Times are Bogota wall-clock TEXT**, `YYYY-MM-DD` or `YYYY-MM-DDTHH:MM`,
   string-comparable. Bogota has no DST, so date math is deliberately
   Z-anchored (`plusMinutes`, `icsWindow`) and the VTIMEZONE is a fixed
   -05:00. Don't introduce real timezone libraries.
6. **Failures surface, never mask.** Blocked scrape → row saved with
   `scrape_status` + a "Releer" button; Claude parse error → "envíalo otra
   vez" reply; invite-mail error → "⚠️ no pude enviar el correo" ack suffix;
   unknown geocode → cached as a miss so it isn't retried every load.
7. **Twinned client/server logic stays in sync**: `mapsLink`/`waLink` and the
   effective-$/m² math (`aptPpm` ↔ `ppmOf`) exist in both `index.ts` and
   `apartments.html`. Rent compares `(price+admin)/m²`; buy uses the stored
   sale `price_per_m2`.
8. **Identity is canonicalized.** `canonVoter` maps Access email local-parts
   and Telegram first names onto `felipe`/`lucia` (unknowns fall back to the
   normalized first token). Web vote/note authorship always comes from the
   `cf-access-authenticated-user-email` header — never from the request body.
9. **External services are treated as donated.** Overpass geocoding runs as a
   background backfill of ≤2 rows per data load, spaced 2 s, each address
   looked up once and cached forever (`geo_address` remembers the exact
   string the coords came from; a changed address re-geocodes). Photo bytes
   are never stored — only permanent Telegram `file_id`s; the short-lived
   `file_path` is resolved per request.

## 3. Directory map

```
wrangler.toml        infra: custom domain turikumwe.cc, 3 crons, D1 binding DB,
                     send_email binding INVITE_MAIL, vars (GROUP_CHAT_ID, INVITE_FROM/TO)
schema.sql           the only schema definition (4 tables) — CREATE TABLE IF NOT EXISTS
src/
  index.ts           ALL logic (~1500 lines): date helpers, votes, geocoding,
                     WhatsApp/maps links, iCalendar invites + MIME mail, db helpers,
                     Telegram send/callback/typing, Claude client, apartment
                     ingest/scrape/extract/rescrape, summary, digest, crons,
                     update handling (ops parser prompt lives here), web routes
  apartments.html    apartment screen: cards, inline edits, map (OSM tiles), photo strip
  dashboard.html     household overview, ✓ buttons ({{SECTIONS}}/{{UPDATED}} placeholders)
  home.html          home screen: pick Household or Apartamentos ({{…}} placeholders)
  icons.ts           PWA icons as base64 (data URIs — see manifest note in §4)
  html.d.ts          declare module '*.html' (text imports)
```

Placeholder substitution uses **function replacers** (`.replace(k, () => v)`)
because the substituted HTML/amounts contain `$`, which string replacers
treat as `$&`-style patterns.

## 4. Route table (src/index.ts `fetch`)

Cloudflare Access fronts every route except the webhook and `/mcp` (each has
its own Bypass application scoped to its path; the web UI application is
OTP-gated to the two emails). The Worker itself authenticates only the
webhook (secret header) and `/mcp` (bearer token).

| Route | Auth | What |
|---|---|---|
| `POST /telegram-webhook` | secret token header | Telegram updates → `handleUpdate` in `waitUntil` (ack first) |
| `POST /mcp` | `Authorization: Bearer` = `MCP_TOKEN` | MCP server (JSON-RPC over streamable HTTP): `query` (read-only SQL), `get_schema`, `add_apartment_note` |
| `GET /` | Access | Home screen with live counts |
| `GET /dashboard.html` | Access | Household items by category, ✓ to complete |
| `POST /items-action` | Access | `complete` (monthly items roll forward); echoes to Telegram except groceries |
| `GET /apartments.html` | Access | Apartment cards + map (static HTML, data via XHR) |
| `GET /apartments-data.json` | Access | Active + ruled-out rows, photos, votes, `me`; kicks off geocode backfill |
| `GET /apt-photo/<id>` | Access | Streams a visit photo from Telegram by stored `file_id` (`?s=t` = thumb) |
| `POST /apartments-action` | Access | `set_visit` / `invite` / `rule_out` / `reactivate` / `rescrape` / `set_fields` / `edit` (allowlisted single field) / `vote` / `apt_note` / `apt_note_del`; most echo to Telegram |
| `GET /manifest.json`, `GET /icon.png` | Access | PWA manifest + icon — icons are **data URIs** because Chrome fetches manifest icons without the Access cookie |

### MCP endpoint

`/mcp` is a hand-rolled, stateless MCP server (no SDK, no Durable Objects, no
SSE — every request gets one JSON response; GET returns 405). It implements
`initialize`, `ping`, `tools/list`, and `tools/call`; notifications are acked
with an empty 202. Three tools:

- **`query`** — one read-only SQL statement against D1. The guard
  (`readOnlySql`) allows a single `SELECT`/`WITH` statement only; because
  SQLite lets `WITH` prefix DML, CTE statements are additionally rejected if
  they contain INSERT/UPDATE/DELETE/REPLACE keywords. Results cap at 300 rows;
  SQL errors come back as tool errors, not protocol errors (failures visible).
- **`get_schema`** — live `sqlite_master` CREATE TABLEs plus the conventions
  blurb (`MCP_DB_CONVENTIONS`: status values, wall-clock formats, notes line
  format, $/m² math). Keep that blurb in sync when conventions change.
- **`add_apartment_note`** — the only write. Goes through `appendAptNote`
  (the shared mutation, per invariant 2) and echoes to the group "— vía MCP".

Any other write stays deliberately unavailable through MCP until decided
otherwise. Auth is a constant bearer-token check against the `MCP_TOKEN`
secret; token holders are household members, so the SQL guard protects
against accidents, not adversaries.

### Telegram update handling (in order)

1. `callback_query` → `handleCallback` (`ro`/`re`/`rs`/`up`/`dn` buttons).
2. Photo → `handlePhoto`: resolve the apartment from the replied-to message
   or a `#id` in the caption; album siblings share the resolution via an
   in-isolate map (best-effort); caption also saved as a note.
3. `/command` → static HELP text.
4. Message containing a URL → apartment ingestion only (dedup by exact URL;
   a blocked-then-resent link is a retry; extra prose >30 chars gets an
   "envíalo aparte" warning). One ack + keyboard per URL.
5. Plain text → Claude ops parser (`{"ops":[...]}` against the live OPEN
   ITEMS / APARTMENTS / RULED OUT lists, plus the replied-to apartment when
   present). Actions: add / complete / remove / query / none / rescrape /
   set_visit / rule_out / reactivate / apt_note / apt_vote / apt_summary.
   Unknown categories coerce to `general` so nothing is dropped.

### Apartment ingestion pipeline

`scrapeListing` (15 s timeout, browser UA, bot-block detection) collects
JSON-LD + `__NEXT_DATA__` + meta + page text as capped evidence →
`extractFields` (Claude, `EXTRACT_SYS`) returns typed JSON → insert. The
og:image is pulled by **regex, not Claude** (LLMs mangle long CDN URLs). A
"not a listing" verdict is only trusted when the scrape succeeded. Rescrapes
(`rescrapeOne` / `retryBlockedScrapes`) reuse `applyScrapedFields`, which
records a price move into `prev_price`/`price_changed_at` (manual price edits
clear it — corrections aren't market signals).

### Geocoding

Bogotá addresses name a street crossing, so free-text geocoders are useless
(street numbers repeat across the city). `parseBogotaAddress` parses the grid
(`Carrera 18 No 82-24` → Carrera 18 × Calle 82), `osmCrossing` pulls both
ways' geometries from Overpass and takes the closest vertex pair, rejecting
pairs >150 m apart or outside the Bogotá bbox. Block-accurate by design.

## 5. Data model (schema.sql)

Four tables, raw SQL, `INTEGER PRIMARY KEY AUTOINCREMENT` ids, ISO-8601 TEXT
timestamps written by the app (no DB defaults for time):

- **`items`** — household todos. `category` ∈ bills/events/groceries/health/
  pediatrician/general; `status` ∈ `open`/`done`/`deleted` (delete is a
  status flip — every query filters `status='open'`); `recurrence='monthly'`
  + `recur_day` makes `complete` roll `due_date` forward instead of closing.
- **`apartments`** — one row per listing. `status` ∈ `active`/`ruled_out`;
  `scrape_status` `ok` or the block reason; `visit_date` date or datetime;
  `visit_reminder_sent` stores the covered **datetime, not a boolean**, so a
  reschedule re-arms the reminder; `notes` is newline-joined stamped lines
  (`YYYY-MM-DD [Autor]: text` — `NOTE_LINE_RE` is the parsing contract);
  `prev_price`/`price_changed_at` hold one prior rescrape price; `geo_lat`/
  `geo_lng`/`geo_address` cache the geocode (miss = `geo_address` set with
  NULL coords).
- **`apartment_votes`** — one 👍/👎 per person per apartment,
  PK `(apartment_id, voter)`, voter canonical (`felipe`/`lucia`), clearing
  deletes the row.
- **`apartment_photos`** — Telegram `file_id` (full) + `tg_thumb_file_id`
  (mid-size), caption, author. No bytes stored.

## 6. Schema migration discipline

`schema.sql` is all `CREATE TABLE IF NOT EXISTS` and there is no migration
tool. Therefore:

- **New table** → add to `schema.sql`, re-apply the file (existing tables
  untouched): `npx wrangler d1 execute household --remote --file schema.sql`.
- **New column** → add to `schema.sql` (for fresh installs) AND run a one-off
  `ALTER TABLE … ADD COLUMN …` against the remote DB **before**
  `wrangler deploy` — the new code's SQL references the column and fails
  until it exists. Record the `ALTER` here.

Applied one-off `ALTER`s on `apartments`, in order (a fresh
`schema.sql` install already has all of them):
`image_url, notes` → `address, agent_name, agent_phone, tag` →
`visit_reminder_sent` → `prev_price, price_changed_at` →
`geo_lat, geo_lng, geo_address`.

## 7. Crons (wrangler.toml ↔ `scheduled()` switch — keep in sync)

| Cron (UTC) | Bogota | What |
|---|---|---|
| `30 12 * * *` | 07:30 | `sendDigest` — full pendientes digest to the group |
| `0 0 * * *` | 19:00 | `sendEveningReminder` (only if something is due/overdue) + `sendPostVisitFollowup` (per visited-today apartment, with 👍/👎/🚫 buttons) |
| `0 * * * *` | hourly | `sendVisitReminders` — ~1 h before each timed visit; 90-min lookahead + `visit_reminder_sent` guarantees exactly one reminder per scheduled datetime |

At 00:00 UTC the evening and hourly crons both fire as separate invocations —
fine. Dispatch is an explicit `switch` on `controller.cron`; an unknown string
logs and does nothing (never guess — a wrong guess spams the group).

## 8. Calendar invites

Setting/clearing a future `visit_date` (from any entry point) emails an
iCalendar REQUEST/CANCEL to both people via the `send_email` binding
(recipients must be verified in the zone's Email Routing settings). **Ruling
out or reactivating an apartment never sends this mail** — a discarded
apartment keeps its `visit_date` and calendar invite exactly as they were;
only a person explicitly changing the visit date cancels or moves it (the
web `set_visit` action works on a `ruled_out` row too, on purpose — it's the
manual override). Stable `UID:visit-<id>@turikumwe.cc` + epoch-seconds
`SEQUENCE` makes reschedules replace rather than duplicate. RFC 5545 line
folding is UTF-8-safe; headers use RFC 2047 for accents. `visitMail` never
throws — mail failure becomes a ⚠️ suffix on the ack, not a broken visit
update.

## 9. Build, run, deploy

- `npm run dev` — `wrangler dev`; first apply the schema locally:
  `npx wrangler d1 execute household --local --file schema.sql`.
- `npm run deploy` — `wrangler deploy`. **Deploy does NOT run migrations** —
  see §6; column migrations go first.
- Setup from scratch (D1 create, secrets, webhook registration, Access apps,
  Android install) is in `README.md`.

## 10. Testing

There are no tests. Verification = `npx tsc --noEmit` plus exercising the
real Telegram group and web screens after deploy. The blast radius of a bug
is two users; the feedback loop is minutes.
