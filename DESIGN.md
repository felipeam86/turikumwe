# DESIGN.md — «Bitácora» (the apartments screen)

This documents **Proposal B**, the design system `src/apartments.html` is built
on. Future changes to that screen should stay on-system: pick tokens and
components from here instead of inventing new ones, and update this file when
a token or rule genuinely changes.

## 1. Concept

The apartment hunt is a story Felipe and Lucía write together: listings get
shared, visited (sometimes by one, sometimes both), impressions get written
down, documents arrive, verdicts form, chapters close. The screen reads as
that **shared logbook** — light, warm, paper-like, editorial — the deliberate
counterpoint to the dark console it replaced. Two ideas carry everything:

- **The spine.** Journal entries hang on a thin vertical line; each entry's
  knot is a small serif disc that says *who* — authorship is visible
  everywhere, always in the same two hues.
- **Chapters and dividers.** Each apartment page is a chronological thread
  whose visits are numbered chapters («Primera visita», «Segunda visita»);
  decisions are typographic chapter dividers («DESCARTADO — muy caro»),
  reversible like everything in the log.

Everything user-facing is Spanish. One self-contained HTML file, no
framework, no build step (repo rule).

## 2. Color tokens

Ink on cream. Person hues are for **authorship only**; green/amber/red are
**semantic only** (verdict/agreement, warning, discard). Nothing else gets
color — restraint is the look.

| token | value | use |
|---|---|---|
| `--paper` | `#F5EFE2` | the page; also `theme-color` and the map pin stroke |
| `--paper2` | `#EDE3CF` | recessed surfaces: composer dock, docs checklist card |
| `--card` | `#FCF8EE` | raised paper: roster cards, banner, buttons, sheet inputs |
| `--ink` | `#28221A` | text, primary buttons, active filter chips, toast |
| `--ink2` | `#5D5545` | secondary text, quotes |
| `--faint` | `#8C8270` | metadata, day labels, disabled-ish |
| `--line` / `--line2` | `#DFD4BC` / `#C9BCA0` | hairline / stronger rules |
| `--felipe` | `#31577F` | *azul tinta* — Felipe's mark (discs, chips) |
| `--lucia` | `#A03E66` | *solferino* — Lucía's mark |
| `--brass` | `#8A6A2F` | the one interactive tint: links, active accents, "scheduled" dot, map pins |
| `--ok` / `--warn` / `--err` | `#3E7A4C` / `#96690F` / `#AE3B2C` | agreement & price-drop / warnings & price-rise / discard |
| `--flash` | `#F0DFA4` | deep-link highlighter (the `#apt-<id>` arrival flash) |

`color-scheme: light` — this proposal commits to its light identity; there is
no dark mode. Person-hue *tints* are the hex + alpha nibble (e.g. `#31577F14`)
so they sit on any paper tone.

## 3. Typography

- **Instrument Serif** (400 + italic; Google Fonts, `Georgia` fallback) — the
  voice of the book: the `Bitácora` wordmark (italic), apartment titles,
  chapter titles, week headers (italic), prices and fact values, quoted
  notes/impressions (italic, inside `.quote`/`.ntxt`).
- **Instrument Sans** (400–700, same foundry; system-sans fallback) — the
  hand of the tool: entry text, metadata, buttons, chips, labels, inputs.

Scale (px): wordmark 30 · apt title 31 · sheet title 22 · chapter 20 ·
week header 19 · fact value 18 · entry text 14.5 · body 15 · meta 12 ·
caps-labels 10–11 with `.08–.09em` tracking, uppercase. Prices always
`font-variant-numeric: tabular-nums`. Caps-labels (`.dayhead`, `.sect2`,
`.nvlabel`, `.fk`, `.vk`) are the only uppercase text.

## 4. Spacing & layout

- Base unit ~7–9px paddings, 10–12px radii on cards/sheets, 999px on
  chips/pills/marks. Hairlines do structure; shadows are never used.
- **375px is the design target.** One column, edge padding
  `14px + env(safe-area-inset-*)`, no horizontal body scroll (roster and
  filter bar scroll inside their own containers, scrollbars hidden).
- **≥960px**: the shell becomes a 220px + 680px grid — the roster turns into
  a sticky side rail of horizontal mini-cards; the reading column stays
  ~680px. (760–959px keeps the single centered column.)
- Touch targets ≥44px; smaller visual buttons get a
  `@media(pointer:coarse)` min-height bump.

## 5. Component inventory

- **Masthead** — italic wordmark + subtitle; ⌂/Hogar links.
- **Tabs** (`.tabs`, sticky) — «Diario» / «Agenda» / «Índice», ink underline
  for the active one. The apartment page counts as Diario.
- **Roster** (`.rcard`) — compact apartment cards: thumb, `#id`, name, price
  in millions (`$3,2 M`, full figure in `title`), stage dot, `docs n/m`, 💚.
  Order: mutual favorites, then best $/m².
- **Stage dot** (`.sdot`) — pendiente = hollow, agendada = brass, visitada =
  ink. Used in roster and Índice rows.
- **Próxima-visita banner** (`.nextv`) — quiet card, brass left rule: when
  (HOY/MAÑANA + hora + countdown), `#id · lugar`, quién va, dirección. It
  opens the Agenda («ver la agenda →»), where the visit sits in its week.
- **Agenda spread** (`#agenda`) — the week's page in a paper planner: one
  Mon–Sun week at a time, ‹ hoy › navigation, an italic serif headline that
  always names the dates («Semana del 3 al 9 de agosto»). Days flow down the
  spine, every day present — an empty day is a quiet rule (dim node + italic
  «libre»); today's header is brass, past days/entries muted (`.agpast`).
  One entry = one scheduled visit row (active AND ruled-out apartments;
  follow-ups are their own entries): the node is quién va, the serif time
  leads (italic «hora por definir» when date-only), then `#id · lugar`
  linking to the story, price/area, and the fixed contact idiom (Maps
  address, WhatsApp + «llamar»). Actions per entry: 📅 Reprogramar (inline
  `datetime-local`, per-visit `visit_edit`), Cancelar (confirm sheet), 📧
  Invitación only on an active apartment's next upcoming visit; ruled-out
  entries render struck through with a `descartado` pill and «↩
  Reconsiderar» — never hidden. A past visit swaps the actions for «✎
  Impresión». **Clash rule:** same-day timed visits whose starts are <60 min
  apart BOTH get «⚠️ choque de horario» (warn pill); date-only visits never
  clash. A visit-less week shows the empty state with the count of
  apartments por agendar, linking to the Índice.
- **Journal entry** (`.ev` inside `.evs`) — spine + node + one-line text +
  meta; optional serif quote and photo strip. Nodes: `F` / `L` /
  split `F·L` discs for people; `$` price, `✕` discard (err), `✦` photos,
  `→ / ✓` visits without quién.
- **Person mark** (`.pm`) — 20px serif initial disc; appears wherever
  authorship or attendance matters.
- **Pills** (`.pill`) — state, never authorship: `sin leer` (warn), `nuevo`
  (brass), visita/visitado/por agendar (neutral), `⬇ bajó $X` (ok) /
  `⬆ subió $X` (warn) while `price_changed_at` is <14 days old, `💚 les
  gustó a los dos` (ok), `descartado` (err). Tag chips keep the
  hash-derived hue (same label ⇒ same color).
- **Facts strip** (`.facts`) — ruled grid (2 cols on phones, 4 from 560px):
  $/mes total (all-in for rent), m², $/m², hab/baños, estrato, parqueadero,
  admin/año, tipo. Serif values, caps labels; best comparable $/m² in green.
- **Verdict row** — my medallion cycles `— → 👍 → 👎 → —`; the partner's is
  read-only; agreement adds the green line.
- **Docs checklist** (`.docscard`) — recessed card: default rows from
  `doc_types` × `deal_type` merged with real rows; status button cycles
  pendiente → recibido → no aplica; `abrir 📎` when the file is stored; ✕
  deletes a mis-filed row; add-«otro» box; «Pedir pendientes por WhatsApp»
  prefills a Spanish wa.me message. Progress reads «n de m» (m excludes «no
  aplica»; shown once at least one row exists).
- **Chapter** (`.chap`) — serif visit title + meta (fecha, quién va with
  marks); impressions as quotes; that day's photos; cancelled visits stay,
  struck through.
- **Divider** (`.divider`) — centered italic serif between rules; err for
  «Descartado — motivo», ok for «les gustó a los dos».
- **Composer** — docked bar on the apartment page only: Nota / Visita /
  Docs n/m / ✕ Descartar (↩ Reconsiderar when ruled out).
- **Sheets** (`.sheet`) — bottom sheets on phones, centered dialogs ≥760px:
  nota, impresión de visita, visitas (reschedule/quién/cancel/invite + new),
  documentos, descartar (reason chips + free text), cancelar visita (the
  agenda's confirm), ficha (all editable fields).
- **Índice** — filter chips (tipo/hab/precio/estado/tag + orden, persisted
  in `localStorage.bitFilters`), comparable rows with serif $/m², descartados
  section with reasons + Reconsiderar, Leaflet map (CARTO `light_all` tiles,
  brass pins, ruled-out pins greyed).
- **Toast** — ink pill above the composer; every action result lands here
  (server `error` verbatim; network failure = «Error de red»).

## 6. Journal-event derivation rules

Events are derived **client-side, only from timestamps the payload actually
carries** — no invented times:

| entry | source | day |
|---|---|---|
| compartió | `created_at` + `created_by` | UTC→Bogotá (−5h fixed) |
| visita programada | visit row, upcoming | `visit_date` day |
| visitaron / X visitó | visit row, past non-cancelled | `visit_date` day |
| nota | each `notes` line via `NOTE_RE` | the line's stamp |
| fotos | `photos[].created_at` | UTC→Bogotá; same-day photos fold into that day's visit entry |
| bajó/subió de precio | `prev_price`/`price_changed_at` | UTC→Bogotá |
| descartado | `ruled_out_at` + reason | UTC→Bogotá |

Votes and docs carry **no timestamp** in `/apartments-data.json`, so they
surface as *state* (💚 pill, `docs n/m`) rather than dated entries — do not
fake dates for them. Feed order: «Por venir» (upcoming visits beyond the
banner, ascending) then weeks descending («Esta semana», «La semana pasada»,
«Semana del X al Y»), days descending (HOY/AYER/weekday), within a day:
descartes → precio → visitas → fotos → notas → compartidos. A timestamp
without `Z`/offset is already Bogotá wall clock — its first 10 chars are the
day (`bogDay`).

## 7. Interaction patterns

- **The hash is the page**: `` `#` ``=Diario, `#agenda`, `#indice`,
  `#apt-<id>` — so
  Telegram deep links land directly on an apartment's story; arrival flashes
  the title block (`--flash` fading over ~2s) and scrolls to top.
- Every mutation goes through `saveAction`: POST → toast (ok message, or the
  server's Spanish `error` verbatim) → full data reload. Network failure:
  «Error de red» + re-render from cached state. No optimistic UI.
- Load failure shows a visible retry whose link is a **full navigation**
  (`href=""`) so Cloudflare Access can redirect. Data reloads on
  `visibilitychange`; there is no polling.
- Photos always open in the in-app lightbox — a bare navigation to
  `/apt-photo/<id>` would make the PWA download the file.
- Sheets that mirror server state (documentos, visitas) re-render after each
  reload; sheets being typed into (nota, ficha, descartar) never re-render
  under the user's fingers.
- My vote control is the only tappable verdict; the server decides who I am
  (`me` in the JSON) — identity is never client-chosen.
- Contact idiom is fixed everywhere: address → Maps (Bogotá-anchored), phone
  → WhatsApp with a `tel:` fallback; listing URLs open in a new tab.

## 8. Motion

Soft and scarce: the sheet slide-up (180ms ease-out), the toast fade, the
arrival flash. Nothing moves on scroll; nothing loops. All of it is disabled
under `prefers-reduced-motion` (the flash degrades to a static highlight).

## 9. Twins

The file carries the client twins of `index.ts` helpers, each marked with a
"twin" comment: `mapsLink`/`waLink`, `effPrice`/`ppmOf`, `priceAreaBits`,
`visitCmp` + `nextVisitOf`/`lastVisitOf`/`stageOf` (stage derivation),
`NOTE_RE`, `aptLabel`, `contactLines`, `vdVal`. Change one side → change the
other (ARCHITECTURE.md §2, invariant 7).
