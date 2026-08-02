# ARCHITECTURE.md — Turikumwe (household + apartment-hunt Worker)

**This file is the gold standard for how this repo is built.** If a change
alters anything described here — a table, route, cron, binding, or invariant —
updating this document is part of that change, not a follow-up. Code and this
file disagreeing means the change is incomplete.

## 1. System overview

One Cloudflare Worker (`household`, https://turikumwe.cc). A Telegram group is
the only input surface: plain messages are parsed by Claude into household
ops, listing URLs are scraped and extracted into apartment rows, photos and
due-diligence documents (PDFs from realtors) attach to apartments, inline
buttons drive one-tap actions. Visits are first-class rows — an apartment can
be visited several times (first visit + follow-ups), each with who went and
how it went. Crons push a morning digest, evening nudges, and visit reminders
back into the group. Two Access-protected web screens mirror the data. All
user-facing text is Spanish.

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
2. **One implementation per mutation.** Rule-out, reactivate, notes, votes,
   visit changes, and document tracking (`ruleOutApt`, `reactivateApt`,
   `appendAptNote`, `upsertVote`, `setVisit`, `addVisit`, `editVisit`,
   `setDoc`) are shared by every entry point: Claude-parsed ops,
   inline-button callbacks, Telegram photo/document handlers, web actions
   (and MCP for notes). Each returns the post-mutation state — callers
   never re-read it — or null on a miss. Concurrency/idempotency lives
   there too — a status predicate on the `UPDATE` plus a `meta.changes`
   check means only the tap that actually flips the row announces; stale
   taps answer "ya estaba hecho". The invite/cancel mail decision
   (`visitMail`) lives inside the visit mutations and fires only on an
   explicit visit change — rule-out and reactivate deliberately never touch
   it, so discarding an apartment never touches its calendar invites; only
   a person editing a visit does. `setVisit` keeps its historical
   semantics — it (re)schedules or clears THE NEXT upcoming visit — while
   `addVisit` always inserts a follow-up and `editVisit` addresses one
   visit row by id. `activeOnly` is the policy seam: the Telegram ops path
   passes it (active rows only), the web omits it — the manual override
   (§8). The group announcement for any of these mutations is built ONLY by
   `aptAnnounce`, which owns the emoji, the escaped `aptRef`, and the
   keyboard; callers pass their attribution suffix (`via`, already
   Markdown-safe) and only choose the delivery channel.
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
   -05:00. Don't introduce real timezone libraries. A date-only visit counts
   as upcoming through the end of its day — `visitCmpJs`/`visitCmpSql` (and
   the client twin `visitCmp`) pad it to `T23:59`; a visit's "hecha" state is
   DERIVED (non-cancelled + in the past), never stored.
6. **Failures surface, never mask.** Blocked scrape → row saved with
   `scrape_status` + a "Releer" button; Claude parse error → "envíalo otra
   vez" reply; a malformed or unimplemented op → "⚠️ No entendí…" ack line
   (`executeOps`' terminal else — only `{"action":"none"}` is deliberate
   silence); a missed apartment id → "❓ No encontré…"; invite-mail error →
   "⚠️ no pude enviar el correo" ack suffix; unknown geocode → cached as a
   miss so it isn't retried every load.
7. **Twinned client/server logic stays in sync**: `mapsLink`/`waLink`, the
   effective-$/m² math (`aptPpm` ↔ `ppmOf`), and the price+area line
   (`priceAreaBits` — rent quotes the all-in monthly `price+admin`) exist in
   both `index.ts` and `apartments.html`. Rent compares `(price+admin)/m²`;
   buy uses the stored sale `price_per_m2`. Contact info renders through one helper per side —
   `contactLines` (web) / `agentBit` (Telegram text) — and the idiom is fixed:
   the address opens Maps, the phone deep-links to WhatsApp (the web adds a
   plain `tel:` fallback). Don't hand-roll a second contact markup.
8. **Identity is canonicalized.** `canonVoter` maps Access email local-parts
   and Telegram first names onto `felipe`/`lucia` (unknowns fall back to the
   normalized first token). Web vote/note authorship always comes from the
   `cf-access-authenticated-user-email` header — never from the request body.
9. **Apartment references are self-identifying.** Location alone is ambiguous
   (two listings can share a neighborhood), so wherever an apartment is named —
   web rows, agenda entries, map popups, modal titles, Telegram acks/digests —
   the reference carries the row `#id` (via `aptRef` in index.ts / `aptLabel`
   in apartments.html) and, where the layout allows, the disambiguating
   fields: price, area, visit date, address, agent name.
10. **External services are treated as donated.** Overpass geocoding runs as a
   background backfill of ≤2 rows per data load, spaced 2 s, each address
   looked up once and cached forever (`geo_address` remembers the exact
   string the coords came from; a changed address re-geocodes). Photo bytes
   are never stored — only permanent Telegram `file_id`s; the short-lived
   `file_path` is resolved per request.

## 3. Directory map

```
wrangler.toml        infra: custom domain turikumwe.cc, 3 crons, D1 binding DB,
                     send_email binding INVITE_MAIL, vars (GROUP_CHAT_ID, INVITE_FROM/TO)
schema.sql           the only schema definition (6 tables) — CREATE TABLE IF NOT EXISTS
seed.sql             demo rows for local dev only (§9) — fixed ids + INSERT OR REPLACE,
                     dates relative to `now`; never run against --remote
.claude/launch.json  `npm run dev` as a Claude Code preview target on port 8787
src/
  index.ts           ALL logic (~1900 lines): date helpers, votes, geocoding,
                     WhatsApp/maps links, iCalendar invites + MIME mail, db helpers,
                     Telegram send/callback/typing, Claude client, apartment
                     ingest/scrape/extract/rescrape, shared mutations (incl. visits +
                     docs) + aptAnnounce, summary, digest, crons, ops vocabulary
                     (OP_LINES) + executeOps, photo/document handlers, web routes
  apartments.html    apartment screen «Radar» (see DESIGN.md): dark mission-control page —
                     HOY hero, pipeline segments, bottom-sheet detail (visitas/docs/notas)
                     over /apartments-data.json + /apartments-action; carries the client
                     twins of §2.7 and the stage derivation (nextVisitOf/lastVisitOf)
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
| `GET /apartments.html` | Access | Apartment screen (static HTML, data via XHR) |
| `GET /apartments-data.json` | Access | Active + ruled-out rows, photos, votes, `visits`, `docs`, `doc_types`, `me`; kicks off geocode backfill |
| `GET /apt-photo/<id>` | Access | Streams a visit photo from Telegram by stored `file_id` (`?s=t` = thumb) |
| `GET /apt-doc/<id>` | Access | Streams a due-diligence document from Telegram by stored `file_id` (with its filename) |
| `POST /apartments-action` | Access | `set_visit` (next visit) / `visit_add` (follow-up) / `visit_edit` / `visit_cancel` (by `visit_id`) / `doc_set` / `doc_del` / `invite` / `rule_out` / `reactivate` / `rescrape` / `set_fields` / `edit` (allowlisted single field) / `vote` / `apt_note` / `apt_note_del`; most echo to Telegram; row-returning mutations return the post-mutation row incl. `visits`/`docs` (`vote` and `invite` return only `ok`) |
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
3. Document (PDF etc.) → `handleDocument`: same reply/`#id` resolution, then
   `setDoc` — classified into a `DOC_TYPES` slug by cheap caption/filename
   keywords (`classifyDoc`, no Claude call), stored like photos (permanent
   `file_id` only) and flipped to `received`. No album handling (paperwork
   rarely travels as one); an unresolved file gets the "¿de cuál apto?" nag.
4. `/command` → static HELP text.
5. Message containing a URL → apartment ingestion only (dedup by exact URL;
   a blocked-then-resent link is a retry; extra prose >30 chars gets an
   "envíalo aparte" warning). One ack + keyboard per URL.
6. Plain text → Claude ops parser (`{"ops":[...]}` against the live OPEN
   ITEMS / APARTMENTS / RULED OUT / DOC TYPES lists, plus the replied-to
   apartment when present). The op vocabulary is `OP_LINES` — ONE table
   whose values are the prompt's op-spec lines and whose keys `executeOps`
   implements: add / complete / remove / query / none / rescrape /
   set_visit / add_visit / visit_note / set_doc / rule_out / reactivate /
   apt_note / apt_vote / apt_summary. `executeOps` runs the parsed ops and
   returns the ack lines (the seam: ops in, ack out). Unknown categories
   coerce to `general` so nothing is dropped; an op that is malformed or
   not implemented is acked "no entendí" — never dropped silently
   (invariant 6). `visit_note` lands on the last visit that happened and
   degrades to a plain apartment note when none has.

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

Six tables, raw SQL, `INTEGER PRIMARY KEY AUTOINCREMENT` ids, ISO-8601 TEXT
timestamps written by the app (no DB defaults for time):

- **`items`** — household todos. `category` ∈ bills/events/groceries/health/
  pediatrician/general; `status` ∈ `open`/`done`/`deleted` (delete is a
  status flip — every query filters `status='open'`); `recurrence='monthly'`
  + `recur_day` makes `complete` roll `due_date` forward instead of closing.
- **`apartments`** — one row per listing. `status` ∈ `active`/`ruled_out`;
  `scrape_status` `ok` or the block reason; `notes` is newline-joined
  stamped lines (`YYYY-MM-DD [Autor]: text` — `NOTE_LINE_RE` is the parsing
  contract); `prev_price`/`price_changed_at` hold one prior rescrape price;
  `geo_lat`/`geo_lng`/`geo_address` cache the geocode (miss = `geo_address`
  set with NULL coords). Visit state does NOT live here anymore (see
  `apartment_visits`; legacy `visit_date`/`visit_reminder_sent` columns may
  linger on old installs, unread — §6).
- **`apartment_visits`** — one row per visit; follow-ups are extra rows.
  `visit_date` date or datetime (wall clock); `who` ∈
  `felipe`/`lucia`/`both`/NULL; `status` ∈ `scheduled`/`cancelled` only —
  "hecha" is derived (non-cancelled + past, date-only counting through end
  of day); `note` holds that visit's impressions as stamped lines;
  `reminder_sent` stores the covered **datetime, not a boolean**, so a
  reschedule re-arms the reminder.
- **`apartment_docs`** — due-diligence documents per apartment. `doc_type`
  is a `DOC_TYPES` slug (or `otro` + free `label`); `status` ∈
  `pending`/`received`/`na`; a row exists only once requested/received (no
  auto-seeded checklist); `tg_file_id`/`file_name`/`mime_type` when the
  actual file arrived via Telegram. No bytes stored.
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
`schema.sql` install has all of them except `visit_date` and
`visit_reminder_sent`, retired by the v2 visits migration below):
`image_url, notes` → `address, agent_name, agent_phone, tag` →
`visit_reminder_sent` → `prev_price, price_changed_at` →
`geo_lat, geo_lng, geo_address`.

**Visits migration (v2).** `apartment_visits`/`apartment_docs` are new
tables — re-applying `schema.sql` creates them. The single visit an
apartment used to carry moves into `apartment_visits` with this one-off.
Run it BEFORE deploying the code that reads the new table, then run it
AGAIN right after the deploy — the `NOT EXISTS` guard makes it idempotent,
and the second pass picks up any visit set through the old code in the gap
(the old model held at most one visit per apartment). Do the whole thing in
one sitting, avoiding the top of an hour when a same-day timed visit is
pending (the reminder cron reads whichever side holds the visit):

```sql
INSERT INTO apartment_visits (apartment_id, visit_date, who, status, reminder_sent, created_by, created_at, updated_at)
SELECT id, visit_date, 'both', 'scheduled', visit_reminder_sent, created_by, updated_at, updated_at
FROM apartments WHERE visit_date IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM apartment_visits av WHERE av.apartment_id = apartments.id);
```

The old `apartments.visit_date`/`visit_reminder_sent` columns stay in place
on migrated installs (SQLite column drops aren't worth the risk here) but no
code reads or writes them; `schema.sql` no longer creates them. One-time
quirk: calendar events sent before the migration used UID
`visit-<aptId>@turikumwe.cc`, new ones are per-visit
(`visit-v<visitId>@…`) — the first post-migration reschedule of an old event
adds a new calendar entry instead of moving the old one.

## 7. Crons (wrangler.toml ↔ `scheduled()` switch — keep in sync)

| Cron (UTC) | Bogota | What |
|---|---|---|
| `30 12 * * *` | 07:30 | `sendDigest` — full pendientes digest to the group (visits section reads `apartment_visits`, shows who goes) |
| `0 0 * * *` | 19:00 | `sendEveningReminder` (only if something is due/overdue) + `sendPostVisitFollowup` (per visited-today apartment — scheduled visits whose datetime passed, deduped per apartment — with 👍/👎/🚫 buttons, a 💬 WhatsApp url button when the agent's phone is stored, and the docs the realtor still owes: `missingDocLabels`, the deal-applicable checklist minus received/na, same notion the web renders) |
| `0 * * * *` | hourly | `sendVisitReminders` — ~1 h before each timed visit (scheduled `apartment_visits` rows joined to active apartments); 90-min lookahead + per-visit `reminder_sent` guarantees exactly one reminder per scheduled datetime; includes who goes and the still-owed docs (`missingDocLabels`) to request in person |

At 00:00 UTC the evening and hourly crons both fire as separate invocations —
fine. Dispatch is an explicit `switch` on `controller.cron`; an unknown string
logs and does nothing (never guess — a wrong guess spams the group).

## 8. Calendar invites

Scheduling, moving, or cancelling an upcoming visit (from any entry point,
always through `setVisit`/`addVisit`/`editVisit`) emails an iCalendar
REQUEST/CANCEL to both people via the `send_email` binding (recipients must
be verified in the zone's Email Routing settings). "Upcoming" means today or
later, wall-clock — the `visitUpcoming` predicate; the web "reenviar
invitación" re-send targets the next upcoming visit. **Ruling out or
reactivating an apartment never sends this mail** — a discarded apartment
keeps its visits and calendar invites exactly as they were; only a person
explicitly editing a visit cancels or moves one (the web omits the
`activeOnly` option on purpose — it's the manual override and works on a
`ruled_out` row too). Stable per-visit `UID:visit-v<visitId>@turikumwe.cc` +
epoch-seconds `SEQUENCE` makes reschedules replace rather than duplicate,
while a follow-up visit is its own calendar event. RFC 5545 line
folding is UTF-8-safe; headers use RFC 2047 for accents. The DESCRIPTION and
the plain-text mail body share one fact sheet (`visitInfoLines`) that carries
Maps and WhatsApp URLs — calendar apps linkify them, so on visit day the
event itself navigates and opens the agent chat. LOCATION and the Dirección
line carry the Bogotá-anchored address (`bogotaAddr`, the same anchor every
maps link gets): calendar apps geocode LOCATION on tap, and a bare street
address resolves in whatever city the reader is standing in. `visitMail` never
throws — mail failure becomes a ⚠️ suffix on the ack, not a broken visit
update.

## 9. Build, run, deploy

- `npm run dev` — serves the web screens on http://localhost:8787. A `predev`
  hook runs `npm run db:local` first (schema + `seed.sql` into the local D1),
  so a fresh clone shows populated screens with no manual step; re-running is
  idempotent. Point Claude Code's preview at it with `.claude/launch.json`
  (config name `household-worker`) — same command locally and on the web.
- **Local dev has no Cloudflare Access**, so the dev script passes
  `--var DEV_USER:felipeam86@turikumwe.cc`; `webUser()` falls back to it when
  the `cf-access-authenticated-user-email` header is absent, which is what
  makes voting and note authorship work locally. A deployed Worker never has
  the var (it's a `wrangler dev` flag, not a `[vars]` entry).
- Telegram echoes and mail from local actions fail silently (no `BOT_TOKEN` /
  no Email Routing) — the D1 write still lands. Crons don't self-trigger
  locally: `curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=30+12+*+*+*"`.
- `npm run typecheck` — `tsc --noEmit`, the only pre-deploy check (§10).
- `npm run deploy` — `wrangler deploy`. **Deploy does NOT run migrations** —
  see §6; column migrations go first.
- Setup from scratch (D1 create, secrets, webhook registration, Access apps,
  Android install) is in `README.md`.

## 10. Testing

There are no tests. Verification = `npx tsc --noEmit` plus exercising the
real Telegram group and web screens after deploy. The blast radius of a bug
is two users; the feedback loop is minutes.
