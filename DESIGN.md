# DESIGN.md — «Radar», the apartments screen design system

This document describes **Proposal A («Radar»)**, the design system implemented
in `src/apartments.html`. It exists so a future change can stay on-system:
before adding a control or a color, find its place here first.

## 1. Concept

Radar is a **dark mission control for a two-person apartment hunt**. The user
is standing on a street in Bogotá between visits, one thumb free, twenty
apartments in their head. The page's single job is to answer, in under three
seconds: **what's NOW, what's NEXT, what's MISSING.**

That framing drives every decision:

- The page opens with a *state*, not a catalog: the HOY board (next visit,
  countdown, the three taps you need mid-street: Maps, agente, docs).
- The list is a *pipeline*, not a gallery: Por agendar → Agendadas →
  Visitadas, one segment on screen at a time, Descartadas folded at the end.
- Everything actionable for one apartment lives in one bottom sheet with a
  sticky thumb-zone bar — no hunting through cards.
- Zero decoration that isn't information. Negative space and hairlines do the
  layout work; color is reserved for meaning.

## 2. Color tokens

Layered near-blacks (never pure #000), blue-shifted like a screen in a dark
room. Defined as CSS custom properties on `:root`.

| Token | Value | Role |
|---|---|---|
| `--bg0` | `#0a0d10` | page background ("tarmac") |
| `--bg1` | `#10151b` | raised card (hero, rows) |
| `--bg2` | `#151c24` | sheet / elevated surface |
| `--bg3` | `#1b232d` | inputs, pressed states |
| `--line` | `#232c36` | hairline borders (the only divider) |
| `--fg` | `#e8eef4` | primary text |
| `--mut` | `#8c97a3` | secondary text |
| `--dim` | `#5c6773` | tertiary / disabled text |
| `--now` | `#56cce8` | **«señal»** — the single accent |
| `--ok` | `#4fd08a` | verdict green (💚, received docs, price drops) |
| `--warn` | `#efb454` | missing / split / price rises / pending docs |
| `--err` | `#ef6e6e` | discard / cancel only |

**The accent rule (the system's backbone):** `--now` cyan means *time* —
now, next, live. It appears ONLY on: the HOY board (signal dot, countdown,
edge stripe), next-visit facts and pills, the accent map pin (upcoming
visit), the agenda's today column (border + day header) and the time
numerals of THE next visit (the same one the HOY board shows), the focus
ring, and the `#apt-<id>` deep-link flash. It is **never**
used for chrome: buttons, links, and active states are neutrals (`--fg` +
borders). Green/amber/red are strictly semantic (verdict / warning /
discard) — never decorative. If a new element wants cyan, ask: *does it mean
"now or next"?* If not, it gets a neutral.

Each semantic color has a `-dim` 12% alpha companion used as pill/badge
background — text in the full color, wash behind it, no borders.

## 3. Typography

Two voices:

- **Display — "Barlow Condensed" (500/600/700, Google Fonts, `--font-d`)**:
  DIN/signage lineage — the departure-board voice. Used for the brand line,
  the HOY clock, segment labels, and section eyebrows. Falls back to
  `"Arial Narrow", "Roboto Condensed"`, then system, so the page survives the
  fonts CDN being unreachable.
- **Body — system stack (`--font-ui`)**: everything else. Money and times get
  `font-variant-numeric: tabular-nums` (class `.num`) so columns of COP
  figures align.

Scale (mobile-first, 375px design target):

| Style | Spec |
|---|---|
| HOY clock | Barlow Cond 700, `clamp(52px, 17vw, 76px)`, line-height .95 |
| HOY clock (non-today, `.far`) | `clamp(34px, 10vw, 46px)` |
| Brand | Barlow Cond 700, 30px, uppercase |
| Sheet price | Barlow Cond 700, 32px |
| Eyebrow (section labels) | Barlow Cond 600, 13px, uppercase, tracking .14em |
| Segment labels | Barlow Cond 600, 15px, uppercase, tracking .08em |
| Row name / sheet title | system 600, 15px / 19px |
| Data lines | system, 12.5–13px, tabular numerals |
| Pills / micro | system 600, 11px |

Eyebrows are the section voice everywhere (VISITAS, DOCUMENTOS, NOTAS,
DESCARTADAS) — quiet muted caps, never bold white headlines.

## 4. Spacing, radii, layout

- 4px base grid; card padding 14–16px; sections separated by 20px +
  hairline (`.sect`).
- Radii: 14px cards, 18px sheet, 12px rows, 10px controls, 999px chips/pills.
- Page column max 1120px. **< 760px:** single column, detail = bottom sheet.
  **≥ 760px:** two-column grid — pipeline left, detail docked right
  (`position: sticky`), same DOM.
- Safe areas respected (`env(safe-area-inset-bottom)` on body, sheet bar,
  toast). Body never scrolls horizontally; anything wide (filter chips,
  photo strip) scrolls inside its own container with hidden scrollbars.

## 5. Component inventory

- **HOY board (`.hero`)** — the signature. 3px accent edge, pulsing signal
  dot, eyebrow ("HOY · PRÓXIMA VISITA"), giant clock, countdown ("en 2 h
  15 min", live via a 30s local re-render — no server polling), apartment
  label, price line, then 46px action tiles: Cómo llegar / Agente / Docs
  (amber badge = pending count) / Reprogramar (swaps to a datetime input in
  place). Empty state = dimmed dot + "Sin visitas programadas" + count of
  por agendar with a jump button.
- **Filter chips (`.chip`)** — one quiet scrolling row: Tipo / Hab / Precio
  (quartile presets) / tags (same-label ⇒ same-hue, hashed) / Orden / Mapa.
  Cycle on tap, persisted in `localStorage` (`radarF`), stale values degrade
  to "off", never crash.
- **Pipeline segments (`.seg`)** — Por agendar / Agendadas / Visitadas with
  live counts; the active segment is the stage filter (persisted, `radarSeg`).
- **View switch (`.vsws`)** — two underline tabs above the segments: Lista /
  Agenda (with the count of upcoming visits). Different axis, different
  shape: the boxed segments ask *what stage*, the tabs ask *which lens* —
  pipeline or week. Persisted (`radarView`); segment taps, deep links, and
  map popups always land on Lista. In Agenda the filter chips and map hide —
  the agenda shows every visit, unfiltered.
- **Agenda (`#agendabox`)** — the hunting week. One week at a time, lun–dom;
  ‹ › move ±7 days, «↩ esta semana» resets when off-week; condensed week
  label («3 – 9 ago»). The first paint opens on the week of the next
  upcoming visit. Every `scheduled` visit row gets an entry — follow-ups as
  separate entries, ruled-out apartments struck through with 🚫 descartado +
  Reactivar, never hidden. Entry anatomy, top to bottom: Barlow Cond 700
  time numerals (or italic «hora por definir» for date-only visits), flag
  pills (🚫 / ⚠️ choque de horario / ✓ hecha), `#id · location` (opens the
  sheet without leaving the week), price · m² · quién va, the one contact
  block (address→Maps, phone→WhatsApp + llamar), then per-visit controls:
  ⏱ Reprogramar (swap-in-place datetime → `visit_edit` on THAT visit), 📧
  Invitación (only the next visit of an active apartment — the server
  re-sends for that one), ✕ Cancelar (two-tap). **Clash rule:** same-day
  TIMED visits whose starts are <60 min apart flag BOTH entries amber;
  date-only visits never clash. Today's column wears the accent border and
  header; past days dim to 55% but stay; an empty day says «libre» (a
  hunting week's gaps are information); a zero-visit week collapses to an
  empty state that nudges with the «por agendar» count. Phones snap-scroll
  the day columns and auto-focus today (else the week's first visit day),
  keeping your day across quick-action re-renders; ≥760px the seven days
  sit side by side full-width until a ficha opens and docks the sheet
  right, when the week compresses back to scrolling columns.
- **Row (`.row`)** — 64px min: thumb, `#id · location` + tag, price·m²·hab
  line, stage fact (next visit in accent / last visit + docs / "sin visita"),
  status pills right (sin leer, nuevo, ⬇bajó/⬆subió, 💚). Whole row opens the
  sheet.
- **Detail sheet (`#detail`)** — bottom sheet (mobile) / docked panel
  (desktop): cover + photo strip (thumbs open the lightbox — never a bare
  navigation), title + pills, big price + $/m², Ver aviso / Releer / Editar
  ficha, facts grid, contact block (address→Maps, phone→WhatsApp + tel:),
  verdict row (mine cycles, partner read-only), then three eyebrow sections:
  - **Visitas** — chronological dots (● next in accent, ✓ hecha, ✕
    cancelada), quién-va chips, Reprogramar-in-place, Invitación (next visit
    only), two-tap Cancelar, per-visit outcome notes, "+ otra visita".
  - **Documentos** — checklist from `doc_types` × `deal_type` merged with
    real rows; progress bar + `recibidos/total`; tap cycles pendiente →
    recibido → no aplica; received files open `/apt-doc/<id>`; "+ Agregar"
    for otro; «Pedir pendientes por WhatsApp» prefilled wa.me message.
  - **Notas** — stamped lines (fecha · autor), delete-exact-line ✕
    (base64-carried raw line), inline composer.
  - **Sticky bar (`.bar`)** — thumb zone: Agendar / WhatsApp / Nota /
    Descartar (or Reactivar). Descartar and Editar swap the sheet body in
    place (reason chips + motivo / full field form) — no stacked modals.
- **Descartadas (`details.ruled`)** — collapsed, dashed border, struck names,
  reason pills, Reconsiderar; rows still open the sheet.
- **Map (`#mapbox`)** — behind the Mapa chip; Leaflet + dark CARTO tiles,
  SRI-pinned CDN, silently absent if the CDN fails. Pin color encodes state:
  accent = upcoming visit, gray = active, dim = descartado. Popups link back
  to `#apt-<id>`.
- **Toast (`.toast`)** — every action result; server errors verbatim,
  network failures as "Error de red".
- **Loading** — shimmer skeletons shaped like the hero and three rows.

## 6. Interaction patterns

- **Tap-to-cycle** is the house verb: verdict (— → 👍 → 👎 → —), doc status,
  filter chips. One tap, one toast, reload truth from the server.
- **Two-tap confirm** (`armed()`): destructive taps (cancel visit, delete
  doc) turn into "¿Seguro?" for 2.6s instead of opening dialogs.
- **Swap-in-place**: Reprogramar replaces its button row with a
  datetime-local; Escape or an untouched blur restores. Editing and
  discarding swap the sheet body, never stack a second layer.
- **Deep links**: `#apt-<id>` (Telegram acks) switches to the right segment,
  opens the sheet, scrolls and flashes the row (`.hilite`, one-shot).
- **Failures visible**: `ok:false` toasts the server's Spanish `error`
  verbatim and still reloads; network errors toast "Error de red" and
  re-render from cache so a failed tap visibly reverts. Initial-load failure
  shows a retry link that is a full navigation (Cloudflare Access redirect).
- All tap targets ≥ 44px. Data reloads on `visibilitychange`; no polling.

## 7. Motion rules

- Interactions ≤ 200ms: sheet slide-up 200ms `cubic-bezier(.32,.72,.28,1)`,
  chip/button state changes 140ms, shade fade 180ms.
- Exactly one ambient motion: the 1.6s signal-dot pulse on the HOY board
  (live = today; dimmed static otherwise). Nothing else loops.
- The deep-link flash keeps the 1.8s accent outline fade.
- `prefers-reduced-motion: reduce` kills all animation and transitions.

## 8. Voice

Spanish, plain verbs, sentence case ("Agendar visita", "Pedir pendientes por
WhatsApp", "De vuelta en la lista"). Labels say what the tap does; toasts
repeat the verb ("Visita reprogramada 📅"). Emoji are functional glyphs
(📍 💬 📄 📅 📧 📝 🚫 ↩️ 💚), used on actions and pills, never in headings.
