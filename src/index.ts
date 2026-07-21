import { EmailMessage } from 'cloudflare:email';
import dashboardHtml from './dashboard.html';
import apartmentsHtml from './apartments.html';
import homeHtml from './home.html';
import { ICON_192, ICON_512 } from './icons';

export interface Env {
  DB: D1Database;
  BOT_TOKEN: string;
  TG_WEBHOOK_SECRET: string;
  ANTHROPIC_API_KEY: string;
  GROUP_CHAT_ID: string;
  INVITE_MAIL: SendEmail;
  INVITE_FROM: string;
  INVITE_TO: string;
}

const TZ = 'America/Bogota'; // UTC-5, no DST
const MODEL = 'claude-sonnet-5';

const CATEGORIES = ['bills', 'events', 'groceries', 'health', 'pediatrician', 'general'] as const;
const CAT_LABEL: Record<string, string> = {
  bills: 'Cuentas', events: 'Eventos', groceries: 'Mercado', health: 'Salud', pediatrician: 'Preguntas pediatra', general: 'General',
};
const CAT_EMOJI: Record<string, string> = {
  bills: '💵', events: '📅', groceries: '🛒', health: '❤️', pediatrician: '🩺', general: '📌',
};

// ---- date helpers ----
function today(): string {
  // en-CA gives YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
// Bogota wall-clock "YYYY-MM-DDTHH:MM" — string-comparable with visit_date (sv-SE formats as ISO)
function nowBogota(): string {
  return new Date().toLocaleString('sv-SE', { timeZone: TZ }).slice(0, 16).replace(' ', 'T');
}
// wall-clock string + N minutes; parsed Z-anchored so only the delta matters (Bogota has no DST)
function plusMinutes(wallClock: string, min: number): string {
  return new Date(Date.parse(wallClock.slice(0, 16) + ':00Z') + min * 60000).toISOString().slice(0, 16);
}
function weekday(): string {
  return new Intl.DateTimeFormat('es-CO', { timeZone: TZ, weekday: 'long' }).format(new Date());
}
function daysBetween(fromISO: string, toISO: string): number {
  // slice(0,10): tolerate a "YYYY-MM-DDTHH:MM" visit timestamp, not just a bare date
  const a = Date.parse(fromISO.slice(0, 10) + 'T00:00:00Z');
  const b = Date.parse(toISO.slice(0, 10) + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}
function addMonth(iso: string, recurDay?: number | null): string {
  const [y, m, d] = iso.split('-').map(Number);
  let ny = y, nm = m + 1;
  if (nm > 12) { nm = 1; ny++; }
  const wantDay = recurDay || d;
  const dim = new Date(Date.UTC(ny, nm, 0)).getUTCDate(); // days in target month
  const nd = Math.min(wantDay, dim);
  return `${ny}-${String(nm).padStart(2, '0')}-${String(nd).padStart(2, '0')}`;
}
function fmtDate(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number); // slice: ignore any "THH:MM" tail
  const mon = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'][m - 1];
  return `${d} ${mon}`;
}
// " HH:MM" suffix when a visit carries a clock time, else "" — visit_date may be a date or a datetime
const hhmm = (ts: string) => { const t = String(ts || '').slice(11, 16); return t ? ' ' + t : ''; };
function dueLabel(dueISO: string, todayISO: string): string {
  const n = daysBetween(todayISO, dueISO);
  if (n < 0) return `⚠️ vencido hace ${-n}d (era ${fmtDate(dueISO)})`;
  if (n === 0) return `⚠️ vence HOY (${fmtDate(dueISO)})`;
  if (n === 1) return `vence mañana (${fmtDate(dueISO)})`;
  return `vence ${fmtDate(dueISO)}`;
}
// due-date sort, nulls last; shared by digest and dashboard
const byDue = (a: any, b: any) => {
  const da = a.due_date || '9999', db = b.due_date || '9999';
  return da < db ? -1 : da > db ? 1 : a.id - b.id;
};
// strip dueLabel's leading warning glyph; shared by digest, evening reminder, dashboard
const stripWarn = (s: string) => s.replace(/^⚠️ /, '');
// human name for an apartment row, with source_site as a last resort before the numeric id
const aptName = (r: any) => r.location || r.title || r.source_site || ('apto ' + r.id);
// ---- per-person verdicts ----
// canonical voter id from any identity we see: Access email local-parts ('felipeam86',
// 'lucia.p.villar') and Telegram first names ('Felipe', 'Lucía') all map to the same person.
// Unknown identities fall back to their normalized first token so nothing breaks.
const VOTER_ALIAS: Record<string, string> = { felipeam86: 'felipe', 'lucia.p.villar': 'lucia' };
function canonVoter(raw: string): string {
  const s = String(raw || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  if (!s) return '';
  if (VOTER_ALIAS[s]) return VOTER_ALIAS[s];
  const first = s.split(/[^a-z0-9]+/)[0] || s;
  return VOTER_ALIAS[first] || first;
}
const VOTER_NAME: Record<string, string> = { felipe: 'Felipe', lucia: 'Lucía' };
const voterName = (v: string) => VOTER_NAME[v] || (v ? v.charAt(0).toUpperCase() + v.slice(1) : v);
async function upsertVote(env: Env, aptId: number, voter: string, vote: 'up' | 'down') {
  await run(env,
    'INSERT INTO apartment_votes (apartment_id, voter, vote, updated_at) VALUES (?,?,?,?) ON CONFLICT(apartment_id, voter) DO UPDATE SET vote=excluded.vote, updated_at=excluded.updated_at',
    aptId, voter, vote, new Date().toISOString());
}
// decode the handful of HTML entities that appear in scraped attribute URLs (&amp; splits query params)
function decodeHtml(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&#0*38;/g, '&').replace(/&quot;/g, '"').replace(/&#0*39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}
// server-side twins of mapsLink/waLink in apartments.html — keep both pairs in sync.
// Maps: anchor the query to Bogotá so a bare street address doesn't resolve elsewhere.
function mapsLink(addr: string): string {
  let a = String(addr || '').trim();
  if (a && !/bogot[aá]/i.test(a)) a += ', Bogotá';
  return 'https://maps.google.com/?q=' + encodeURIComponent(a);
}
// ---- geocoding (OSM/Overpass — keyless, results cached in the row) ----
// A Bogotá address names a CROSSING, not a point: "Carrera 18 No 82-24" is on Carrera 18 near
// Calle 82. Free-text geocoders are useless here — street names repeat across the city, so
// "Calle 77" happily resolves to Calle 77 Sur in Ciudad Bolívar, 15 km from the listing. Instead
// we parse the grid ourselves and ask OSM where those two roads actually meet, which lands
// within a block of the door. Pins are therefore block-accurate, not door-accurate.
const BOGOTA_BBOX = { s: 4.55, w: -74.16, n: 4.82, e: -74.00 };
// "82", "83a", "93 bis" → the way name OSM uses ("Calle 83A", "Calle 93 Bis")
const gridNum = (n: string, bis?: string, letter?: string) =>
  n + (bis ? ' Bis' : '') + (letter ? letter.toUpperCase() : '');
const GRID_NUM = '(\\d{1,3})\\s*(bis)?\\s*([a-z])?';
const GRID_VIA = '(calle|cll|cl|carrera|cra|kra|kr|car|avenida calle|av calle|ac|avenida carrera|av carrera|ak|diagonal|dg|transversal|tv)';
// the two roads a Colombian address refers to, or null when it isn't in grid form
function parseBogotaAddress(raw: string): { a: string; b: string } | null {
  // building names ("Edificio Colpatria") and landmarks ("Al lado del Raddisson") ride along in
  // real data; the anchored number pair is matched wherever it sits in the string
  const s = String(raw || '').toLowerCase().replace(/[.,]/g, ' ').replace(/\s+/g, ' ').trim();
  let m = s.match(new RegExp(GRID_VIA + '\\s*' + GRID_NUM + '\\s*(?:no|nro|n°|#|°)?\\s*' + GRID_NUM + '\\s*-\\s*\\d+'));
  if (m) {
    const via = m[1], first = gridNum(m[2], m[3], m[4]), second = gridNum(m[5], m[6], m[7]);
    const isCalle = /^(calle|cll|cl|avenida calle|av calle|ac|diagonal|dg)$/.test(via);
    return isCalle ? { a: 'Calle ' + first, b: 'Carrera ' + second }
                   : { a: 'Carrera ' + first, b: 'Calle ' + second };
  }
  // bare "73 con 9" — by local convention the calle comes first
  m = s.match(new RegExp('^' + GRID_NUM + '\\s*(?:con|x|y|&)\\s*' + GRID_NUM + '$'));
  if (m) return { a: 'Calle ' + gridNum(m[1], m[2], m[3]), b: 'Carrera ' + gridNum(m[4], m[5], m[6]) };
  return null;
}
// Overpass matches names with POSIX regex — no \s, so spaces stay literal. The same road is
// tagged "Calle 92" / "Avenida Calle 92" / "Av. Calle 92", and "93 Bis" also appears as "93B".
function osmNameRegex(v: string): string {
  const flex = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ +Bis$/i, ' *(bis|b)').replace(/ +/g, ' *');
  return '^(av\\.? *|avenida )?' + flex + '$';
}
// where the two roads meet. Asking for a shared node misses the many crossings OSM doesn't
// node-connect, so we pull both geometries and take their closest pair of vertices.
async function osmCrossing(p: { a: string; b: string }): Promise<{ lat: number; lng: number } | null> {
  const bb = `${BOGOTA_BBOX.s},${BOGOTA_BBOX.w},${BOGOTA_BBOX.n},${BOGOTA_BBOX.e}`;
  const data = `[out:json][timeout:25];
way["highway"]["name"~"${osmNameRegex(p.a)}",i](${bb})->.a;
way["highway"]["name"~"${osmNameRegex(p.b)}",i](${bb})->.b;
.a out geom;
.b out geom;`;
  const r = await fetch('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    signal: AbortSignal.timeout(30000),
    // Overpass answers 406 without a User-Agent
    headers: { 'user-agent': 'turikumwe.cc household worker (apartment hunt map)' },
    body: new URLSearchParams({ data }),
  });
  if (!r.ok) throw new Error('overpass ' + r.status); // 429/504 are common — caller retries later
  const j: any = await r.json();
  const A: any[] = [], B: any[] = [];
  const key = p.a.toLowerCase().replace(/\s+/g, '');
  for (const w of j.elements || []) {
    const nm = String(w.tags?.name || '').toLowerCase().replace(/\s+/g, '');
    (nm.includes(key) ? A : B).push(...(w.geometry || []));
  }
  if (!A.length || !B.length) return null;
  let best: { d: number; lat: number; lon: number } | null = null;
  for (const x of A) for (const y of B) {
    const d = (x.lat - y.lat) ** 2 + ((x.lon - y.lon) * 0.997) ** 2; // lon shrinks by cos(4.7°)≈1
    if (!best || d < best.d) best = { d, lat: (x.lat + y.lat) / 2, lon: (x.lon + y.lon) / 2 };
  }
  // the roads must genuinely meet: >150 m apart means we matched two that never cross, and a
  // confident-looking pin in the wrong place is worse than no pin at all
  if (!best || Math.sqrt(best.d) * 111320 > 150) return null;
  if (best.lat < BOGOTA_BBOX.s || best.lat > BOGOTA_BBOX.n || best.lon < BOGOTA_BBOX.w || best.lon > BOGOTA_BBOX.e) return null;
  return { lat: best.lat, lng: best.lon };
}
// geo_address remembers the exact address string the coords came from, so an edited address
// re-geocodes and an unchanged one never hits the API again. An address we cannot place still
// writes geo_address (with NULL coords) so it isn't retried on every page load; transient
// failures (network, 429/504) leave the row unmarked and retry next time.
async function geocodeApt(env: Env, row: { id: number; address: string | null }): Promise<void> {
  const addr = String(row.address || '').trim();
  if (!addr) return;
  const parsed = parseBogotaAddress(addr);
  try {
    const hit = parsed ? await osmCrossing(parsed) : null;
    if (hit) {
      await run(env, 'UPDATE apartments SET geo_lat=?, geo_lng=?, geo_address=? WHERE id=?', hit.lat, hit.lng, addr, row.id);
      return;
    }
    await run(env, 'UPDATE apartments SET geo_lat=NULL, geo_lng=NULL, geo_address=? WHERE id=?', addr, row.id);
  } catch (e: any) {
    console.log('geocode error:', addr, String(e && e.message || e));
  }
}
// background sweep for rows whose address is new or changed. Overpass is a donated shared
// service and these queries are chunky, so keep the batch small and spaced; each address is
// looked up once and cached forever, and pins appear on the next data load.
async function geocodeBackfill(env: Env): Promise<void> {
  const rows = await all(env,
    "SELECT id, address FROM apartments WHERE address IS NOT NULL AND address!='' AND (geo_address IS NULL OR geo_address!=address) LIMIT 2");
  for (let i = 0; i < rows.length; i++) {
    if (i) await new Promise((res) => setTimeout(res, 2000));
    await geocodeApt(env, rows[i]);
  }
}
// WhatsApp: wa.me needs a full international number; bare 10-digit Colombian mobiles (start with 3) get +57
function waLink(phone: string): string {
  let d = String(phone || '').replace(/\D/g, '');
  if (d.length === 10 && d.charAt(0) === '3') d = '57' + d;
  return 'https://wa.me/' + d;
}
// legacy-Markdown safety for interpolated free text (addresses, agent/apartment names, scraped
// URLs). Escape the four characters the legacy parser treats as markup openers…
const mdEscape = (s: unknown) => String(s ?? '').replace(/([_*`\[])/g, '\\$1');
// …and build links whose label/url can't break out of the entity: brackets stripped from the
// label, parens percent-encoded in the url (the legacy parser ends the url at the first ')').
// Raw URLs must never go in message text bare: mid-word `_` pairs silently corrupt them.
function mdLink(label: string, url: string): string {
  return '[' + String(label).replace(/[\[\]]/g, '') + '](' + String(url).replace(/\(/g, '%28').replace(/\)/g, '%29') + ')';
}

// ---- calendar invites (iCalendar over the Email Routing send_email binding) ----
// visit_date is wall-clock Bogota ("YYYY-MM-DD" or "YYYY-MM-DDTHH:MM"); Bogota has no DST,
// so a fixed -05:00 VTIMEZONE is valid for every date.
const icsEscape = (s: string) => String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
// RFC 5545 §3.1: content lines fold at 75 octets; continuations start with a space
function icsFold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 74) return line;
  const out: string[] = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + 74, bytes.length);
    while (end > start && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--; // never split a UTF-8 char
    out.push(new TextDecoder().decode(bytes.subarray(start, end)));
    start = end;
  }
  return out.join('\r\n ');
}
const icsStampNow = () => new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
// event window: timed visits get a 1-hour slot, date-only visits become an all-day event
function icsWindow(vd: string): { start: string; end: string; allDay: boolean } {
  if (vd.length > 10) {
    const t = Date.parse(vd.slice(0, 16) + ':00Z'); // Z-anchored math: +1h with no timezone shifts
    const f = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').slice(0, 15);
    return { start: f(t), end: f(t + 3600000), allDay: false };
  }
  const d = Date.parse(vd.slice(0, 10) + 'T00:00:00Z');
  const f = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').slice(0, 8);
  return { start: f(d), end: f(d + 86400000), allDay: true };
}
const inviteTos = (env: Env) => env.INVITE_TO.split(',').map((s) => s.trim()).filter(Boolean);
function visitIcs(env: Env, row: any, method: 'REQUEST' | 'CANCEL', vd: string): string {
  const w = icsWindow(vd);
  const desc = [
    row.address ? 'Dirección: ' + row.address : '',
    row.agent_name ? 'Agente: ' + row.agent_name : '',
    row.agent_phone ? 'Tel: ' + row.agent_phone : '',
    row.url ? 'Link: ' + row.url : '',
  ].filter(Boolean).join('\n');
  const lines = [
    'BEGIN:VCALENDAR',
    'PRODID:-//turikumwe//visitas//ES',
    'VERSION:2.0',
    'METHOD:' + method,
    ...(w.allDay ? [] : [
      'BEGIN:VTIMEZONE', 'TZID:' + TZ, 'BEGIN:STANDARD', 'DTSTART:19700101T000000',
      'TZOFFSETFROM:-0500', 'TZOFFSETTO:-0500', 'TZNAME:-05', 'END:STANDARD', 'END:VTIMEZONE',
    ]),
    'BEGIN:VEVENT',
    // stable UID per apartment + epoch-seconds SEQUENCE: a re-send after a reschedule
    // strictly increases SEQUENCE, so calendars replace the event instead of duplicating it
    `UID:visit-${row.id}@turikumwe.cc`,
    'SEQUENCE:' + Math.floor(Date.now() / 1000),
    'DTSTAMP:' + icsStampNow(),
    `ORGANIZER;CN=Turikumwe:mailto:${env.INVITE_FROM}`,
    ...inviteTos(env).map((a) => `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${a}`),
    w.allDay ? `DTSTART;VALUE=DATE:${w.start}` : `DTSTART;TZID=${TZ}:${w.start}`,
    w.allDay ? `DTEND;VALUE=DATE:${w.end}` : `DTEND;TZID=${TZ}:${w.end}`,
    'SUMMARY:' + icsEscape('Visita: ' + aptName(row)),
    ...(row.address ? ['LOCATION:' + icsEscape(row.address)] : []),
    ...(desc ? ['DESCRIPTION:' + icsEscape(desc)] : []),
    'STATUS:' + (method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(icsFold).join('\r\n') + '\r\n';
}
const b64 = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};
const b64wrap = (s: string) => b64(s).replace(/(.{76})/g, '$1\r\n');
// RFC 2047 for header values with accents ("Visita: Chicó")
const encHeader = (s: string) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?utf-8?B?${b64(s)}?=`);
async function sendInviteMail(env: Env, row: any, method: 'REQUEST' | 'CANCEL', vd: string): Promise<void> {
  const ics = visitIcs(env, row, method, vd);
  const subject = (method === 'CANCEL' ? 'Cancelada — ' : '') + `Visita: ${aptName(row)} · ${fmtDate(vd)}${hhmm(vd)}`;
  const text = [
    (method === 'CANCEL' ? 'Visita cancelada: ' : 'Visita programada: ') + aptName(row),
    'Fecha: ' + fmtDate(vd) + hhmm(vd),
    row.address ? 'Dirección: ' + row.address : '',
    row.agent_name ? 'Agente: ' + row.agent_name : '',
    row.agent_phone ? 'Tel: ' + row.agent_phone : '',
    row.url ? 'Link: ' + row.url : '',
  ].filter(Boolean).join('\n');
  const tos = inviteTos(env);
  const boundary = 'turikumwe-' + row.id + '-' + Date.now().toString(36);
  const raw = [
    `From: Turikumwe <${env.INVITE_FROM}>`,
    'To: ' + tos.join(', '),
    'Subject: ' + encHeader(subject),
    'Date: ' + new Date().toUTCString(),
    `Message-ID: <visit-${row.id}-${Date.now().toString(36)}@turikumwe.cc>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64wrap(text),
    `--${boundary}`,
    `Content-Type: text/calendar; charset=utf-8; method=${method}`,
    'Content-Transfer-Encoding: base64',
    '',
    b64wrap(ics),
    `--${boundary}--`,
    '',
  ].join('\r\n');
  for (const to of tos) await env.INVITE_MAIL.send(new EmailMessage(env.INVITE_FROM, to, raw));
}
// decide invite vs cancel after a visit change; returns an ack suffix and never throws —
// a mail hiccup must not break the visit update itself, but it must not be silent either
async function visitMail(env: Env, row: any, vd: string | null, oldVd: string | null): Promise<string> {
  const td = today();
  try {
    if (vd && String(vd).slice(0, 10) >= td) { await sendInviteMail(env, row, 'REQUEST', String(vd)); return ' · 📧 invitación enviada'; }
    if (!vd && oldVd && String(oldVd).slice(0, 10) >= td) { await sendInviteMail(env, row, 'CANCEL', String(oldVd)); return ' · 📧 cancelación enviada'; }
    return ''; // past visits get no mail
  } catch (e: any) {
    console.log('invite mail error:', String(e && e.message || e));
    return ' · ⚠️ no pude enviar el correo de invitación';
  }
}

// ---- db helpers ----
async function all(env: Env, sql: string, ...binds: unknown[]): Promise<any[]> {
  return (await env.DB.prepare(sql).bind(...binds).all()).results as any[];
}
async function get(env: Env, sql: string, ...binds: unknown[]): Promise<any | null> {
  return await env.DB.prepare(sql).bind(...binds).first<any>();
}
async function run(env: Env, sql: string, ...binds: unknown[]) {
  return await env.DB.prepare(sql).bind(...binds).run();
}
async function openItems(env: Env) {
  return all(env, "SELECT id,category,title,notes,due_date,recurrence,recur_day,amount FROM items WHERE status='open' ORDER BY category, id");
}
// complete an open item; monthly items roll forward instead of closing
async function completeItem(env: Env, id: number): Promise<{ ok: boolean; title?: string; next?: string; category?: string }> {
  const it = await get(env, 'SELECT * FROM items WHERE id=? AND status=?', id, 'open');
  if (!it) return { ok: false };
  const now = new Date().toISOString();
  if (it.recurrence === 'monthly' && it.due_date) {
    const next = addMonth(it.due_date, it.recur_day);
    await run(env, 'UPDATE items SET due_date=?, last_reminded=NULL, updated_at=? WHERE id=?', next, now, it.id);
    return { ok: true, title: it.title, next, category: it.category };
  }
  await run(env, 'UPDATE items SET status=?, updated_at=? WHERE id=?', 'done', now, it.id);
  return { ok: true, title: it.title, category: it.category };
}

// ---- telegram ----
// inline-keyboard shorthand: kb([[btn, btn], [btn]]) — one inner array per button row
type TgBtn = { text: string; url?: string; callback_data?: string };
const kb = (rows: TgBtn[][]) => ({ inline_keyboard: rows });

async function tgSend(env: Env, text: string, replyTo?: number, replyMarkup?: unknown) {
  const send = (payload: Record<string, unknown>) =>
    fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  const reply = replyTo ? { reply_to_message_id: replyTo, allow_sending_without_reply: true } : {};
  const markup = replyMarkup ? { reply_markup: replyMarkup } : {};
  let r = await send({ chat_id: env.GROUP_CHAT_ID, text, parse_mode: 'Markdown', ...reply, ...markup });
  // ponytail: if legacy-Markdown parsing rejects the text, resend plain rather than dropping the ack
  if (!r.ok) r = await send({ chat_id: env.GROUP_CHAT_ID, text, ...reply, ...markup });
  // still failing with a keyboard attached (e.g. Telegram rejecting a pasted listing url as a
  // button url) → the text matters more than the buttons
  if (!r.ok && replyMarkup) r = await send({ chat_id: env.GROUP_CHAT_ID, text, ...reply });
  if (!r.ok) console.log('tgSend failed:', r.status, (await r.text().catch(() => '')).slice(0, 200));
}

// answerCallbackQuery clears the client-side spinner on a tapped button; text shows as a toast
async function tgAnswerCallback(env: Env, callbackQueryId: string, text?: string) {
  await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, ...(text ? { text } : {}) }),
  }).catch(() => {});
}

// fire-and-forget "typing…" indicator (Telegram shows it ~5s) so slow scrape/Claude work isn't dead air
function tgTyping(env: Env) {
  fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendChatAction`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: env.GROUP_CHAT_ID, action: 'typing' }),
  }).catch(() => {});
}

const HELP = [
  '🤖 *Cómo usarme:*',
  '• Anota lo que sea: "pagar el gas el 20", "cena con Andrés el viernes", "faltan pañales".',
  '• Marca algo hecho: "pagué el arriendo", "ya compramos los pañales".',
  '• Quita un error: "borra lo de la farmacia".',
  '• Pregunta: "¿qué hay pendiente?"',
  '• Pega el link de un apartamento y lo guardo con precio y detalles.',
  '• Apartamentos: responde al mensaje del apto y di "visita el martes a las 10am" y agendo la visita con hora; también "agenda visita al apto 2 el sábado 3pm", "descarta el de Cedritos", "reactiva el apto 1", "el de Chicó nos gustó" (queda como nota), "me encantó el apto 3" (queda tu 👍), "reintenta" (relee links bloqueados).',
  '• Fotos de visitas: responde al mensaje del apto con la foto (o pon "#id" en el pie) y la guardo en su tarjeta.',
  '• "resumen de aptos" te muestra cómo va la búsqueda.',
  '📱 App: https://turikumwe.cc',
].join('\n');

// ---- claude ----
async function claude(env: Env, system: string, user: string): Promise<string> {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!r.ok) throw new Error(`anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j: any = await r.json();
  return (j.content || []).find((b: any) => b.type === 'text')?.text || '{}';
}
function jsonFrom(raw: string): any {
  return JSON.parse(raw.replace(/^[^{]*/, '').replace(/[^}]*$/, ''));
}

// ================= APARTMENTS =================
const URL_RE = /https?:\/\/[^\s]+/i;
function extractUrls(t: string): string[] {
  const out: string[] = []; const re = /https?:\/\/[^\s]+/gi; let m;
  while ((m = re.exec(t))) out.push(m[0].replace(/[)\].,]+$/, ''));
  return out;
}
function classifyDeal(t: string): string {
  const s = (t || '').toLowerCase();
  if (/(arriendo|arrendar|alquiler|\brenta\b|rentar|en arriendo|\brent\b|\blease\b)/.test(s)) return 'rent';
  if (/(compra|comprar|\bventa\b|en venta|adquirir|para comprar|\bbuy\b|purchase)/.test(s)) return 'buy';
  return 'unknown';
}
function siteOf(u: string): string {
  try { return new URL(u).host.replace(/^www\./, ''); } catch { return ''; }
}
function money(n: any): string {
  if (n == null || isNaN(Number(n))) return '';
  return '$' + Number(n).toLocaleString('es-CO');
}

async function scrapeListing(url: string): Promise<any> {
  try {
    const signal = AbortSignal.timeout(15000);
    const r = await fetch(url, {
      redirect: 'follow', signal, headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
        'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'es-CO,es;q=0.9,en;q=0.8',
      },
    });
    const html = await r.text();
    if (html.length < 6000 && /Just a moment|challenge-platform|captcha|Access Denied|Request unsuccessful/i.test(html)) return { ok: false, blocked: 'bot', host: siteOf(url) };
    const jsonld = Array.from(html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)).map(m => m[1].trim()).join('\n').slice(0, 6000);
    const nextm = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    const next = nextm ? nextm[1].slice(0, 5000) : '';
    const meta = Array.from(html.matchAll(/<meta[^>]+(?:property|name)=["'](og:[^"']+|description|twitter:[^"']+|product:[^"']+)["'][^>]*content=["']([^"']*)["']/gi)).map(m => m[1] + ': ' + m[2]).join('\n').slice(0, 1500);
    const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 4000);
    const evidence = ['JSON-LD:\n' + jsonld, 'NEXT_DATA:\n' + next, 'META:\n' + meta, 'PAGE TEXT:\n' + text].join('\n\n').slice(0, 14000);
    if (!jsonld && !next && !meta && text.length < 200) return { ok: false, blocked: 'empty', host: siteOf(url) };
    // deterministic regex, not Claude — LLMs mangle long CDN URLs and the meta evidence is truncated.
    // match the og:image tag in either attribute order (the ["'] after og:image excludes og:image:width/alt),
    // then pull + entity-decode its content so &amp;-split query params survive.
    const ogTag = html.match(/<meta[^>]+og:image["'][^>]*>/i)?.[0];
    const raw = ogTag ? ogTag.match(/content=["']([^"']+)["']/i)?.[1] : null;
    const image = raw ? decodeHtml(raw) : null;
    return { ok: true, evidence, host: siteOf(url), image };
  } catch (e: any) {
    return { ok: false, blocked: 'error', error: String(e && e.message || e), host: siteOf(url) };
  }
}

const EXTRACT_SYS = [
  'You extract structured data about ONE real-estate listing in Colombia (prices in COP).',
  'You get the message the user typed AND scraped evidence from the listing page (may be empty).',
  'Prefer the scraped evidence; fill gaps from the user message. Use null when unknown - never guess.',
  'Parse Colombian formats: "$1.600.000" = 1600000; "2.5M"/"2,5 millones" = 2500000; "65 m2" = 65. admin/administracion = monthly HOA fee.',
  'Return ONLY JSON: {"is_listing":true|false,"title":str|null,"price":int|null,"admin_fee":int|null,"bedrooms":int|null,"bathrooms":int|null,"area_m2":number|null,"parking":int|null,"stratum":int|null,"location":str|null,"year_built":int|null,"amenities":str|null,"deal_type":"buy"|"rent"|"unknown"}.',
  'is_listing: set false ONLY when the page/message is clearly NOT a property listing (video, news article, social post, storefront). When unsure, or when scraped evidence is unavailable, use true.',
  'price = monthly rent (rent) or sale price (buy). location = neighborhood + city. amenities = short comma list if notable.',
].join('\n');

async function extractFields(env: Env, input: string): Promise<any> {
  try {
    return jsonFrom(await claude(env, EXTRACT_SYS, input));
  } catch { return {}; }
}

async function ingestApartment(env: Env, url: string, msgText: string, who: string): Promise<any> {
  // exact-URL dedup before the expensive scrape + Claude call
  const existing = await get(env, 'SELECT id,status,scrape_status,location,title,source_site,ruled_out_reason FROM apartments WHERE url=? LIMIT 1', url);
  if (existing) {
    // a re-sent link whose first read was blocked is a retry, not a dup — re-read it now
    if (existing.scrape_status && existing.scrape_status !== 'ok') {
      const rr = await rescrapeOne(env, existing.id);
      return { reread: true, id: existing.id, ok: rr.ok, blocked: rr.blocked, name: aptName(existing), priceChange: rr.priceChange };
    }
    return { dup: true, id: existing.id, status: existing.status, reason: existing.ruled_out_reason, name: aptName(existing) };
  }
  const deal = classifyDeal(msgText);
  const scr = await scrapeListing(url);
  const input = 'USER MESSAGE:\n' + (msgText || '') + '\n\nDEAL HINT: ' + deal + '\n\nSCRAPED EVIDENCE (' + (scr.ok ? ('ok from ' + scr.host) : ('UNAVAILABLE: ' + scr.blocked)) + '):\n' + (scr.ok ? scr.evidence : '(none)');
  const f = await extractFields(env, input);
  // only trust a "not a listing" verdict when we actually read the page — a blocked/empty scrape must still save
  if (scr.ok && f.is_listing === false) return { skipped: true };
  const dt = (f.deal_type === 'buy' || f.deal_type === 'rent') ? f.deal_type : (deal !== 'unknown' ? deal : 'unknown');
  const ppm = (f.price && f.area_m2 && f.area_m2 > 0) ? Math.round(Number(f.price) / Number(f.area_m2)) : null;
  const now = new Date().toISOString();
  const res = await run(env,
    "INSERT INTO apartments (url,deal_type,title,price,admin_fee,bedrooms,bathrooms,area_m2,price_per_m2,parking,stratum,location,year_built,amenities,source_site,raw_note,scrape_status,image_url,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?,?)",
    url, dt, f.title || null, f.price || null, f.admin_fee || null, f.bedrooms || null, f.bathrooms || null, f.area_m2 || null, ppm, f.parking || null, f.stratum || null, f.location || null, f.year_built || null, f.amenities || null, scr.host || siteOf(url), msgText || null, scr.ok ? 'ok' : scr.blocked, scr.image || null, who || 'group', now, now);
  return { id: res.meta.last_row_id, deal: dt, f, ppm, scr };
}

type PriceChange = { from: number; to: number } | null;
// "· ⬇️ bajó de $X a $Y" (or ⬆️ subió) suffix for rescrape acks; '' when the price held
const priceChangeNote = (pc: PriceChange) =>
  pc ? ` · ${pc.to < pc.from ? '⬇️ bajó' : '⬆️ subió'} de ${money(pc.from)} a ${money(pc.to)}` : '';
async function applyScrapedFields(env: Env, row: any, scr: any): Promise<{ f: any, dt: string, ppm: number | null, priceChange: PriceChange }> {
  const input = 'USER MESSAGE:\n' + (row.raw_note || '') + '\n\nSCRAPED EVIDENCE (ok from ' + scr.host + '):\n' + scr.evidence;
  const f = await extractFields(env, input);
  const dt = (f.deal_type === 'buy' || f.deal_type === 'rent') ? f.deal_type : (row.deal_type || 'unknown');
  const ppm = (f.price && f.area_m2 && f.area_m2 > 0) ? Math.round(Number(f.price) / Number(f.area_m2)) : row.price_per_m2;
  const now = new Date().toISOString();
  // a re-read that moves the price is a market signal (negotiation lever) — remember the old
  // value and when. First scrapes and unchanged prices keep whatever change record exists.
  const priceChange: PriceChange = (f.price != null && row.price != null && Number(f.price) !== Number(row.price))
    ? { from: Number(row.price), to: Number(f.price) } : null;
  await run(env,
    "UPDATE apartments SET deal_type=?,title=?,price=?,admin_fee=?,bedrooms=?,bathrooms=?,area_m2=?,price_per_m2=?,parking=?,stratum=?,location=?,year_built=?,amenities=?,image_url=?,prev_price=?,price_changed_at=?,scrape_status='ok',updated_at=? WHERE id=?",
    dt, f.title || row.title, f.price ?? row.price, f.admin_fee ?? row.admin_fee, f.bedrooms ?? row.bedrooms, f.bathrooms ?? row.bathrooms, f.area_m2 ?? row.area_m2, ppm, f.parking ?? row.parking, f.stratum ?? row.stratum, f.location || row.location, f.year_built ?? row.year_built, f.amenities || row.amenities, scr.image || row.image_url,
    priceChange ? row.price : (row.prev_price ?? null), priceChange ? now : (row.price_changed_at ?? null), now, row.id);
  return { f, dt, ppm, priceChange };
}

async function rescrapeOne(env: Env, id: number): Promise<any> {
  const row = await get(env, 'SELECT * FROM apartments WHERE id=?', id);
  if (!row) return { ok: false, error: 'not-found' };
  const scr = await scrapeListing(row.url);
  if (!scr.ok) {
    await run(env, 'UPDATE apartments SET scrape_status=?, updated_at=? WHERE id=?', scr.blocked || 'error', new Date().toISOString(), id);
    return { ok: false, id, blocked: scr.blocked, host: scr.host };
  }
  const { priceChange } = await applyScrapedFields(env, row, scr);
  return { ok: true, id, priceChange };
}

async function retryBlockedScrapes(env: Env): Promise<{ updated: any[], still: any[] }> {
  const rows = await all(env, "SELECT * FROM apartments WHERE status='active' AND scrape_status IS NOT NULL AND scrape_status!='ok'");
  const updated: any[] = []; const still: any[] = [];
  for (const row of rows) {
    tgTyping(env); // each scrape can take up to 15s; keep the indicator alive per row
    const scr = await scrapeListing(row.url);
    if (!scr.ok) { still.push({ host: scr.host, blocked: scr.blocked }); continue; }
    const { f, dt, ppm, priceChange } = await applyScrapedFields(env, row, scr);
    updated.push({ id: row.id, f, ppm, dt, priceChange });
  }
  return { updated, still };
}

// deep link straight to the card in the web app (apartments.html scrolls to and highlights #apt-<id>)
const aptLink = (id: number | string) => 'https://turikumwe.cc/apartments.html#apt-' + id;

// ---- shared apartment mutations ----
// One implementation for the Telegram ops loop, the web actions, and callback buttons — including
// the calendar-invite side effects. Both return null when the row isn't in the required status,
// which doubles as the idempotency check for stale button taps.
async function ruleOutApt(env: Env, id: number, rawReason: unknown): Promise<{ row: any; reason: string | null; mail: string } | null> {
  const row = await get(env, "SELECT * FROM apartments WHERE id=? AND status='active'", id);
  if (!row) return null;
  const reason = (rawReason && String(rawReason).trim()) ? String(rawReason).trim().slice(0, 120) : null;
  const now = new Date().toISOString();
  // status predicate + changes check: two concurrent taps can both pass the SELECT, but only the
  // invocation whose UPDATE actually flips the row gets to send mail and announce
  const res = await run(env, "UPDATE apartments SET status='ruled_out', ruled_out_reason=?, ruled_out_at=?, updated_at=? WHERE id=? AND status='active'", reason, now, now, id);
  if (!res.meta.changes) return null;
  const mail = await visitMail(env, row, null, row.visit_date); // pending visit? tell the calendars it's off
  return { row, reason, mail };
}
async function reactivateApt(env: Env, id: number): Promise<{ row: any; mail: string } | null> {
  const row = await get(env, "SELECT * FROM apartments WHERE id=? AND status='ruled_out'", id);
  if (!row) return null;
  const res = await run(env, "UPDATE apartments SET status='active', ruled_out_reason=NULL, ruled_out_at=NULL, updated_at=? WHERE id=? AND status='ruled_out'", new Date().toISOString(), id);
  if (!res.meta.changes) return null;
  const mail = await visitMail(env, row, row.visit_date, null); // pending visit comes back → re-invite
  return { row, mail };
}
// append one attributed, stamped note line ("YYYY-MM-DD [Autor]: text") — the format every reader parses
async function appendAptNote(env: Env, id: number, author: string, note: string) {
  const stamped = today() + (author ? ' [' + author + ']' : '') + ': ' + String(note).trim().slice(0, 300);
  await run(env, "UPDATE apartments SET notes=COALESCE(notes||char(10),'')||?, updated_at=? WHERE id=?", stamped, new Date().toISOString(), id);
}

function apartmentAck(rec: any): string {
  const f = rec.f, dt = rec.deal;
  const label = dt === 'rent' ? 'arriendo' : dt === 'buy' ? 'compra' : 'sin especificar (dime si es compra o arriendo)';
  const lines: string[] = ['🏠 *Apartamento guardado* (' + label + ')  #' + rec.id];
  const loc = f.location || f.title || 'Sin ubicación';
  let priceStr = money(f.price);
  if (dt === 'rent' && priceStr) priceStr += '/mes';
  lines.push('*' + loc + '*' + (priceStr ? (' — ' + priceStr) : ''));
  const specs: string[] = [];
  if (f.bedrooms != null) specs.push('🛏 ' + f.bedrooms + ' hab');
  if (f.bathrooms != null) specs.push('🛁 ' + f.bathrooms + ' baños');
  if (f.area_m2 != null) specs.push('📐 ' + f.area_m2 + ' m²');
  if (rec.ppm) specs.push('≈' + money(rec.ppm) + '/m²');
  if (specs.length) lines.push(specs.join(' · '));
  const extra: string[] = [];
  if (f.admin_fee != null) extra.push('🏢 Admin ' + money(f.admin_fee));
  if (f.stratum != null) extra.push('estrato ' + f.stratum);
  if (f.parking != null) extra.push('🚗 ' + f.parking + ' parq.');
  if (extra.length) lines.push(extra.join(' · '));
  if (!rec.scr.ok) {
    lines.push('_No pude leer la página automáticamente (' + rec.scr.blocked + '). Guardé lo que escribiste; toca 🔁 Releer (o escribe "reintenta") para volver a probar._');
  }
  // no trailing deep link: the 📱 button on this ack covers it, and the #id keeps replies resolvable
  return lines.join('\n');
}

// ================= APARTMENT SUMMARY =================
// effective $/m²: rent compares (price+admin)/m² — mirror of ppmOf in apartments.html — buy uses the stored sale $/m²
function aptPpm(r: any): number | null {
  if (r.deal_type === 'rent') {
    return (r.price != null && r.area_m2 > 0) ? Math.round((Number(r.price) + Number(r.admin_fee || 0)) / Number(r.area_m2)) : null;
  }
  return (r.price_per_m2 && r.price_per_m2 > 0) ? r.price_per_m2 : null;
}
// "mar" for a YYYY-MM-DD(THH:MM) wall-clock date — UTC-anchored so the date never shifts
const wdShort = (iso: string) => new Intl.DateTimeFormat('es-CO', { timeZone: 'UTC', weekday: 'short' }).format(new Date(iso.slice(0, 10) + 'T00:00:00Z'));
// note lines are "YYYY-MM-DD: text" or "YYYY-MM-DD [Autor]: text"
const NOTE_LINE_RE = /^(\d{4}-\d{2}-\d{2})(?: \[([^\]]+)\])?: (.*)$/;

async function buildAptSummary(env: Env): Promise<string> {
  const rows = await all(env, 'SELECT * FROM apartments');
  const active = rows.filter((r: any) => r.status === 'active');
  const ruled = rows.filter((r: any) => r.status === 'ruled_out');
  const td = today();
  const out: string[] = [`🏢 *Búsqueda de apto* — ${active.length} activo${active.length === 1 ? '' : 's'} · ${ruled.length} descartado${ruled.length === 1 ? '' : 's'}`];
  const visits = active.filter((r: any) => r.visit_date && String(r.visit_date).slice(0, 10) >= td)
    .sort((a: any, b: any) => String(a.visit_date) < String(b.visit_date) ? -1 : 1).slice(0, 5);
  if (visits.length) {
    out.push('📅 *Próximas visitas:*\n' + visits.map((v: any) =>
      `• ${aptName(v)} #${v.id} — ${wdShort(v.visit_date)} ${fmtDate(v.visit_date)}${hhmm(v.visit_date)}`).join('\n'));
  }
  const toSchedule = active.filter((r: any) => !r.visit_date);
  if (toSchedule.length) {
    const shown = toSchedule.slice(0, 8).map((r: any) => {
      let pr = money(r.price);
      if (r.deal_type === 'rent' && pr) pr += '/mes';
      return `• ${aptName(r)} #${r.id}${pr ? ' — ' + pr : ''}`;
    });
    if (toSchedule.length > 8) shown.push(`… y ${toSchedule.length - 8} más`);
    out.push('⏳ *Por agendar visita:*\n' + shown.join('\n'));
  }
  for (const [dt, label] of [['rent', 'arriendo'], ['buy', 'compra']] as const) {
    const ranked = active.filter((r: any) => r.deal_type === dt)
      .map((r: any) => ({ r, ppm: aptPpm(r) }))
      .filter((x: any) => x.ppm && x.ppm > 0)
      .sort((a: any, b: any) => a.ppm - b.ppm).slice(0, 3);
    if (!ranked.length) continue;
    out.push(`🏆 *Mejor $/m² (${label}):*\n` + ranked.map(({ r, ppm }: any) => {
      // rent shows the all-in monthly (price+admin) so the price matches the ranked $/m²
      const total = dt === 'rent' ? Number(r.price) + Number(r.admin_fee || 0) : r.price;
      const bits = [money(ppm) + '/m²', money(total) + (dt === 'rent' ? '/mes' : ''), r.area_m2 ? r.area_m2 + ' m²' : ''].filter(Boolean).join(' · ');
      return `• ${aptName(r)} #${r.id} — ${bits}`;
    }).join('\n'));
  }
  const notes: { d: string; line: string }[] = [];
  for (const r of rows) {
    for (const ln of String(r.notes || '').split('\n')) {
      const m = ln.match(NOTE_LINE_RE);
      if (m) notes.push({ d: m[1], line: `• ${aptName(r)}${m[2] ? ' (' + m[2] + ')' : ''}: ${m[3]}` });
    }
  }
  if (notes.length) {
    notes.sort((a, b) => a.d < b.d ? -1 : a.d > b.d ? 1 : 0);
    out.push('📝 *Últimas notas:*\n' + notes.slice(-3).map((n) => n.line).join('\n'));
  }
  out.push('📱 https://turikumwe.cc/apartments.html');
  return out.join('\n\n');
}

// ================= DIGEST =================
async function buildDigestBody(env: Env, td: string, header: string): Promise<string> {
  const open = await openItems(env);
  const out: string[] = [header];
  // bills reminder set first (due within 1 day or overdue)
  const bills = open.filter((i: any) => i.category === 'bills' && i.due_date);
  const dueBills = bills.filter((b: any) => daysBetween(td, b.due_date) <= 1).sort(byDue);
  if (dueBills.length) {
    out.push('💵 *Cuentas por pagar ya:*\n' + dueBills.map((b: any) =>
      `• ${b.title}${b.amount ? (' (' + b.amount + ')') : ''} — ${dueLabel(b.due_date, td)}`).join('\n'));
  }
  // everything else by category, soonest due first
  for (const cat of CATEGORIES) {
    const items = open.filter((i: any) => i.category === cat && !(cat === 'bills' && dueBills.some((d: any) => d.id === i.id))).sort(byDue);
    if (!items.length) continue;
    const rows = items.map((i: any) => {
      let s = '• ' + i.title;
      if (i.due_date) s += ' — ' + dueLabel(i.due_date, td);
      else if (i.amount) s += ' (' + i.amount + ')';
      return s;
    });
    out.push(`${CAT_EMOJI[cat]} *${CAT_LABEL[cat]}:*\n` + rows.join('\n'));
  }
  // upcoming apartment visits live in the apartments table, not items
  const visits = await all(env, "SELECT location, title, source_site, id, visit_date, address, agent_name, agent_phone FROM apartments WHERE status='active' AND visit_date>=? ORDER BY visit_date", td);
  if (visits.length) {
    out.push('🏢 *Visitas de apartamentos:*\n' + visits.map((v: any) => {
      let s = `• ${mdEscape(aptName(v))} #${v.id} — ${stripWarn(dueLabel(v.visit_date, td))}${hhmm(v.visit_date)}`;
      if (v.address) s += ` · 📍 ${mdLink(v.address, mapsLink(v.address))}`;
      if (v.agent_phone) s += ` · 💬 ${mdLink(v.agent_name || v.agent_phone, waLink(v.agent_phone))}`;
      return s;
    }).join('\n'));
  }
  if (out.length === 1) out.push('_Todo al día — nada pendiente. 🎉_');
  return out.join('\n\n');
}

async function sendDigest(env: Env) {
  const td = today();
  const wd = weekday();
  const body = await buildDigestBody(env, td, `🏠 *Pendientes de la casa — ${wd} ${fmtDate(td)}*`);
  await tgSend(env, body + '\n\n📱 https://turikumwe.cc');
}

// evening nudge: only what is due today or overdue, only if there is something
async function sendEveningReminder(env: Env) {
  const td = today();
  const due = (await openItems(env)).filter((i: any) => i.due_date && i.due_date <= td).sort(byDue);
  if (!due.length) return;
  await tgSend(env, '⚠️ *Sigue pendiente hoy:*\n' + due.map((i: any) =>
    `• ${CAT_EMOJI[i.category]} ${i.title} — ${stripWarn(dueLabel(i.due_date, td))}`).join('\n'));
}

// ~1 h before each timed visit. Hourly cron + 90-min lookahead guarantees every visit lands in
// exactly one window; visit_reminder_sent stores the covered datetime (not a boolean), so
// rescheduling automatically re-arms the reminder. Date-only visits are the digest's job.
async function sendVisitReminders(env: Env) {
  const now = nowBogota();
  const rows = await all(env,
    "SELECT * FROM apartments WHERE status='active' AND visit_date IS NOT NULL AND length(visit_date)>10 AND visit_date>? AND visit_date<=? AND (visit_reminder_sent IS NULL OR visit_reminder_sent!=visit_date)",
    now, plusMinutes(now, 90));
  for (const r of rows) {
    const lines = [`🔔 *Visita en ~1h — ${String(r.visit_date).slice(11, 16)}* · *${mdEscape(aptName(r))}* #${r.id}`];
    if (r.address) lines.push(`📍 ${mdLink(r.address, mapsLink(r.address))}`);
    if (r.agent_name) lines.push(`👤 ${mdEscape(r.agent_name)}`);
    // the links live in buttons (url buttons never touch the Markdown parser)
    const row1: TgBtn[] = [];
    if (r.address) row1.push({ text: '🗺 Cómo llegar', url: mapsLink(r.address) });
    if (r.agent_phone) row1.push({ text: '💬 Agente', url: waLink(r.agent_phone) });
    const row2: TgBtn[] = [];
    if (r.url) row2.push({ text: '🔗 Anuncio', url: r.url });
    row2.push({ text: '📱 Abrir en la app', url: aptLink(r.id) });
    await tgSend(env, lines.join('\n'), undefined, kb(row1.length ? [row1, row2] : [row2]));
    await run(env, 'UPDATE apartments SET visit_reminder_sent=? WHERE id=?', r.visit_date, r.id);
  }
}

// evening of a visit day: ask how it went. One message per apartment, each carrying the #id, so a
// plain reply resolves via replyAptFromMsg and the ops parser stores it as an apt_note — no new
// plumbing. visit_date<=now skips tonight's still-pending visits (a date-only visit sorts before
// any "T…" timestamp of its day, so it counts as done by evening).
async function sendPostVisitFollowup(env: Env) {
  const rows = await all(env,
    "SELECT * FROM apartments WHERE status='active' AND visit_date IS NOT NULL AND substr(visit_date,1,10)=? AND visit_date<=?",
    today(), nowBogota());
  for (const r of rows) {
    await tgSend(env, `🗣 ¿Cómo les fue en *${mdEscape(aptName(r))}* #${r.id}? Un toque para el veredicto, o respondan a este mensaje y lo guardo como nota.`,
      undefined, kb([
        [{ text: '👍 Nos gustó', callback_data: 'up:' + r.id }, { text: '👎 No', callback_data: 'dn:' + r.id }],
        [{ text: '🚫 Descartar', callback_data: 'ro:' + r.id }],
      ]));
  }
}

// When the user replies to the message that shared a listing (or the bot's ack for it) and asks to
// schedule a visit, resolve which apartment so no name is needed: match the shared URL, then the "#id" the ack prints.
async function replyAptFromMsg(env: Env, msg: any): Promise<{ id: number; name: string } | null> {
  const rt = msg?.reply_to_message;
  if (!rt) return null;
  const t = String(rt.text || rt.caption || '');
  for (const u of extractUrls(t)) {
    const row = await get(env, 'SELECT * FROM apartments WHERE url=? LIMIT 1', u);
    if (row) return { id: row.id, name: aptName(row) };
  }
  const m = t.match(/#(\d+)/);
  if (m) {
    const row = await get(env, 'SELECT * FROM apartments WHERE id=?', Number(m[1]));
    if (row) return { id: row.id, name: aptName(row) };
  }
  return null;
}

// ================= TELEGRAM UPDATE PROCESSING =================
// Inline-keyboard callbacks. data is a server-generated "verb:id" string; anything else
// (wrong chat, malformed data, missing row) just clears the spinner and does nothing.
// A stale tap — the action already done or undone elsewhere — answers "ya estaba hecho".
async function handleCallback(env: Env, cq: any) {
  const m = String(cq?.data || '').match(/^(ro|re|rs|up|dn):(\d+)$/);
  if (!m || String(cq?.message?.chat?.id) !== String(env.GROUP_CHAT_ID)) { await tgAnswerCallback(env, cq.id); return; }
  const verb = m[1];
  const id = Number(m[2]);
  const who = cq.from?.first_name || 'alguien';
  const row = await get(env, 'SELECT * FROM apartments WHERE id=?', id);
  if (!row) { await tgAnswerCallback(env, cq.id, 'Ese apartamento ya no existe'); return; }

  if (verb === 'ro') {
    const res = await ruleOutApt(env, id, null);
    if (!res) { await tgAnswerCallback(env, cq.id, 'Ya estaba hecho 👍'); return; }
    await tgAnswerCallback(env, cq.id, 'Descartado 🚫');
    await tgSend(env, `🚫 *${mdEscape(aptName(row))}* #${id} descartado — ${who}, vía botón${res.mail}`,
      undefined, kb([[{ text: '↩️ Reactivar', callback_data: 're:' + id }]]));
    return;
  }
  if (verb === 're') {
    const res = await reactivateApt(env, id);
    if (!res) { await tgAnswerCallback(env, cq.id, 'Ya estaba hecho 👍'); return; }
    await tgAnswerCallback(env, cq.id, 'De vuelta ↩️');
    await tgSend(env, `↩️ *${mdEscape(aptName(row))}* #${id} de vuelta en la lista — ${who}, vía botón${res.mail}`);
    return;
  }
  if (verb === 'rs') {
    if (row.scrape_status === 'ok') { await tgAnswerCallback(env, cq.id, 'Ya estaba leído 👍'); return; }
    // answer BEFORE the scrape: it can run 15 s+, past the window in which Telegram still
    // accepts the answer — a late answer is silently rejected and the button spins forever
    await tgAnswerCallback(env, cq.id, 'Leyendo… 🔍');
    tgTyping(env);
    const rr = await rescrapeOne(env, id);
    if (rr.ok) await tgSend(env, `🔄 Releí *${mdEscape(aptName(row))}* #${id} — ${who}, vía botón${priceChangeNote(rr.priceChange)}\n` + aptLink(id));
    else await tgSend(env, `⚠️ Sigo sin poder leer *${mdEscape(aptName(row))}* #${id} (${rr.blocked || 'error'}) — prueba más tarde.`,
      undefined, kb([[{ text: '🔁 Releer', callback_data: 'rs:' + id }]]));
    return;
  }
  // up/dn: one-tap post-visit verdict — a canned note attributed to whoever tapped
  if (row.status !== 'active') { await tgAnswerCallback(env, cq.id, 'Ese apartamento está descartado'); return; }
  const note = verb === 'up' ? '👍 nos gustó' : '👎 no nos gustó';
  // the keyboard stays on the message forever, so dedup a repeat tap: same person, same
  // verdict, same day → already recorded
  if (String(row.notes || '').split('\n').includes(today() + ' [' + who + ']: ' + note)) {
    await tgAnswerCallback(env, cq.id, 'Ya registrado 👍');
    return;
  }
  await appendAptNote(env, id, who, note);
  // the tap is also a structured per-person verdict, not just prose
  await upsertVote(env, id, canonVoter(who), verb === 'up' ? 'up' : 'down');
  await tgAnswerCallback(env, cq.id, 'Nota guardada 📝');
  await tgSend(env, `📝 Nota en *${mdEscape(aptName(row))}* #${id}: ${note} — ${who}, vía botón`);
}

// a photo message: attach it to the apartment resolved from the replied-to message or a "#id"
// in the caption. The caption, when present, is usually an impression — store it as a note too.
//
// Albums arrive as one update per photo, and the user's caption rides on only ONE of them.
// Remember each album's resolved apartment (and whether we already nagged) in isolate memory so
// caption-attributed albums save every photo. Best-effort: a cold isolate can still miss a
// sibling, but the updates of one album virtually always land on the same isolate together.
const ALBUM_APT = new Map<string, { id: number; name: string; at: number }>();
const ALBUM_NAGGED = new Map<string, number>();
function albumPrune() {
  const cutoff = Date.now() - 10 * 60000;
  for (const [k, v] of ALBUM_APT) if (v.at < cutoff) ALBUM_APT.delete(k);
  for (const [k, at] of ALBUM_NAGGED) if (at < cutoff) ALBUM_NAGGED.delete(k);
}
async function handlePhoto(env: Env, msg: any) {
  const sizes = msg.photo; // Telegram sends sizes ascending — the last is the full-resolution one
  const fileId = String(sizes[sizes.length - 1].file_id);
  // a mid-size rendition for the web thumb strip: the smallest ≥240px wide, else the largest
  const thumbId = String((sizes.find((s: any) => Number(s.width) >= 240) || sizes[sizes.length - 1]).file_id);
  const caption = String(msg.caption || '').trim();
  const album = msg.media_group_id ? String(msg.media_group_id) : null;
  albumPrune();
  let apt = await replyAptFromMsg(env, msg); // reads only reply_to_message, so it works on photos
  if (!apt) {
    const m = caption.match(/#(\d+)/);
    const row = m ? await get(env, 'SELECT * FROM apartments WHERE id=?', Number(m[1])) : null;
    if (row) apt = { id: row.id, name: aptName(row) };
  }
  if (!apt && album) {
    // caption-less album sibling — its captioned sibling may still be in flight; give it a
    // moment, then adopt the album's resolution from memory
    if (!ALBUM_APT.has(album)) await new Promise((res) => setTimeout(res, 4000));
    apt = ALBUM_APT.get(album) || null;
  }
  if (!apt) {
    if (album) { // nag once per album, not once per photo
      if (ALBUM_NAGGED.has(album)) return;
      ALBUM_NAGGED.set(album, Date.now());
    }
    await tgSend(env, '📸 ¿De cuál apto? Responde al mensaje del apartamento con la foto, o pon "#id" en el pie.', msg.message_id);
    return;
  }
  if (album) ALBUM_APT.set(album, { id: apt.id, name: apt.name, at: Date.now() });
  const who = msg.from?.first_name || null;
  await run(env, 'INSERT INTO apartment_photos (apartment_id, tg_file_id, tg_thumb_file_id, caption, created_by, created_at) VALUES (?,?,?,?,?,?)',
    apt.id, fileId, thumbId, caption || null, who, new Date().toISOString());
  if (caption) await appendAptNote(env, apt.id, who || '', caption);
  await tgSend(env, `📸 Foto guardada en *${mdEscape(apt.name)}* #${apt.id}`, msg.message_id);
}

async function handleUpdate(env: Env, update: any) {
  if (update?.callback_query) { await handleCallback(env, update.callback_query); return; }
  const msg = update?.message;
  if (!msg || String(msg.chat?.id) !== String(env.GROUP_CHAT_ID)) return;
  // photos first — they have no text, so they'd be dropped by the guard below.
  // Albums arrive as one update per photo; each is saved and acked individually.
  if (Array.isArray(msg.photo) && msg.photo.length) { await handlePhoto(env, msg); return; }
  const text = String(msg.text || '').trim();
  if (!text) return;
  const who = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || 'group';
  const td = today();

  // any /command → help (it's just the two of them; no BotFather registration needed)
  if (text.startsWith('/')) {
    await tgSend(env, HELP, msg.message_id);
    return;
  }

  // URL message → apartment ingestion only. One ack message per URL, so each
  // inline keyboard unambiguously belongs to its apartment.
  if (URL_RE.test(text)) {
    const acks: { text: string; markup?: unknown }[] = [];
    for (const u of extractUrls(text)) {
      tgTyping(env);
      try {
        const rec = await ingestApartment(env, u, text, who);
        if (rec.reread) {
          acks.push(rec.ok
            ? { text: '🔄 Ya lo tenías (#' + rec.id + ') y no se había podido leer — lo releí ahora' + priceChangeNote(rec.priceChange) + '.\n' + aptLink(rec.id) }
            : {
              text: '🔁 Ya lo tenías guardado: *' + rec.name + '* #' + rec.id + '. Sigo sin poder leer la página (' + (rec.blocked || 'error') + ').\n' + aptLink(rec.id),
              markup: kb([[{ text: '🔁 Releer', callback_data: 'rs:' + rec.id }]]),
            });
        } else if (rec.dup) {
          const st = rec.status === 'ruled_out' ? ' — estaba *descartado*' + (rec.reason ? ' (' + rec.reason + ')' : '') : '';
          acks.push({ text: '🔁 Ya lo tenías guardado: *' + rec.name + '* #' + rec.id + st + '.\n' + aptLink(rec.id) });
        } else if (rec.skipped) {
          acks.push({ text: '🔗 Ese link no parece un anuncio de apartamento — no lo guardé. Si sí lo es, reenvíalo diciendo que es un apto.' });
        } else {
          const row2: TgBtn[] = [{ text: '🚫 Descartar', callback_data: 'ro:' + rec.id }];
          if (!rec.scr.ok) row2.push({ text: '🔁 Releer', callback_data: 'rs:' + rec.id });
          acks.push({
            text: apartmentAck(rec),
            markup: kb([[{ text: '📱 Abrir en la app', url: aptLink(rec.id) }, { text: '🔗 Anuncio', url: u }], row2]),
          });
        }
      } catch (e: any) {
        acks.push({ text: 'No pude guardar un apartamento (' + String(e && e.message || e).slice(0, 80) + ').' });
      }
    }
    // household text riding along with a URL is not parsed — say so instead of dropping it silently
    const rest = text.replace(new RegExp(URL_RE.source, 'gi'), '').trim();
    if (rest.length > 30) acks.push({ text: '_Ojo: en mensajes con link solo guardo el apartamento — si había algo más que anotar, envíalo aparte._' });
    for (const a of acks) await tgSend(env, a.text, msg.message_id, a.markup);
    return;
  }

  // plain message → Claude ops
  tgTyping(env);
  const wd = weekday();
  const open = await openItems(env);
  const openForModel = open.map((i: any) => ({ id: i.id, category: i.category, title: i.title, due_date: i.due_date }));
  const blockedCount = (await get(env, "SELECT COUNT(*) c FROM apartments WHERE status='active' AND scrape_status!='ok'"))?.c || 0;
  const aptList = (await all(env, "SELECT id, location, title, deal_type, visit_date FROM apartments WHERE status='active' ORDER BY created_at DESC")).map((a: any) => ({ id: a.id, name: (a.location || a.title || ('apto ' + a.id)), deal: a.deal_type, visit: a.visit_date }));
  const ruledList = (await all(env, "SELECT id, location, title, deal_type FROM apartments WHERE status='ruled_out' ORDER BY updated_at DESC")).map((a: any) => ({ id: a.id, name: (a.location || a.title || ('apto ' + a.id)), deal: a.deal_type }));
  const replyApt = await replyAptFromMsg(env, msg); // set when this message replies to an apartment message

  const sys = [
    'You are the parser for a household logging assistant used by a couple in a Telegram group to track home life.',
    `Today is ${td} (${wd}) in the household timezone. Convert incoming messages into structured operations.`,
    'Categories: bills, events, groceries, health, pediatrician, general.',
    'Return ONLY a JSON object: {"ops":[...]}. No prose, no code fences.',
    'Each op is exactly one of:',
    '  {"action":"add","category":"<cat>","title":"<short label>","due_date":"YYYY-MM-DD"|null,"recurrence":"monthly"|"none","recur_day":<1-31>|null,"amount":"<string>"|null}',
    '  {"action":"complete","id":<id from OPEN ITEMS>}',
    '  {"action":"remove","id":<id from OPEN ITEMS>} (user wants to delete/undo a mis-logged item without doing it: "borra eso", "quita el de la farmacia", "me equivoqué, eso no va")',
    '  {"action":"query"}   (user is asking what is pending / what is on the list)',
    '  {"action":"none"}    (chit-chat, greeting, nothing to track)',
    '  {"action":"rescrape"} (user asks to retry reading an apartment listing that could not be read automatically: "reintenta", "vuelve a intentar el scraping", "intenta de nuevo")',
    '  {"action":"set_visit","apt_id":<id from APARTMENTS>,"visit_date":"YYYY-MM-DDTHH:MM"|"YYYY-MM-DD"|null} (user schedules a visit to an apartment: "visito el de Chicó el martes a las 10am", "la visita del apto 2 es el 20 a las 3pm", "agenda visita apto 1 mañana"; include the clock time as THH:MM in 24h when the user gives one — "10am"=>T10:00, "3pm"=>T15:00 — otherwise date only; visit_date=null cancels a visit)',
    '  {"action":"rule_out","apt_id":<id from APARTMENTS>,"reason":"<short reason>"|null} (user wants to discard / stop considering an apartment: "descarta el apto 2", "ya no me interesa el de Chico Norte", "quita el más caro", "bájalo de la lista", "rule out the Cedritos one"; if they say why, capture a short reason like "muy caro", "muy lejos", "sin parqueadero")',
    '  {"action":"reactivate","apt_id":<id from RULED OUT>} (user wants to reconsider a previously discarded apartment: "vuelve a considerar el apto 2", "reactiva el de Chico Norte", "devuelve el descartado a la lista")',
    '  {"action":"apt_note","apt_id":<id from APARTMENTS>,"note":"<short note>"} (user records an opinion or fact about an apartment, often after a visit: "el de Chico Norte nos encantó", "apto 2: cocina pequeña pero buena luz", "el de Cedritos tiene mala vista")',
    '  {"action":"apt_vote","apt_id":<id from APARTMENTS or RULED OUT>,"vote":"up"|"down"} (the SENDER gives their own verdict on an apartment: "me encantó el apto 3", "el de Chicó me gustó", "a mí no me convenció el 2". When the phrasing speaks for both ("nos gustó", "nos encantó a los dos"), emit the sender\'s apt_vote AND the apt_note as before — never emit a vote for someone who did not send the message.)',
    '  {"action":"apt_summary"} (user asks for an overview of the apartment hunt: "resumen de aptos", "cómo va la búsqueda", "qué apartamentos tenemos", "cuáles nos faltan por ver")',
    'Rules:',
    '- One message may produce several ops (e.g. "low on diapers and formula" => two grocery adds).',
    '- Bills that recur (rent, mortgage, utilities, subscriptions, internet, phone): recurrence="monthly", recur_day=the day-of-month it is due, due_date=the NEXT upcoming occurrence (YYYY-MM-DD). One-off bills: recurrence="none", set due_date.',
    '- Convert every relative date to an absolute YYYY-MM-DD, choosing the next upcoming occurrence. "the 20th" => 20th of this month if still ahead, else next month.',
    '- To mark something done/paid/bought, use "complete" with the matching OPEN ITEM id ("rent paid", "got the diapers", "done with the pharmacy run").',
    '- events: things that happen on a date — birthdays, anniversaries, appointments, and social plans (lunch with a friend, a movie, a dinner). Put the date in due_date, recurrence "none", title = a short description.',
    '- groceries: anything to buy for the home — food, drinks, household and cleaning supplies (dish sponge, detergent, paper towels), toiletries, diapers, formula. Title = just the item.',
    '- health: an actual health matter for anyone in the household — Felipe, Lucia, or the baby Mateo: symptoms, medications, illnesses, doctor/dentist/pediatrician appointments, things to monitor.',
    '- pediatrician: a question or topic to raise with the pediatrician at the next visit (about the baby Mateo) — e.g. "ask about sleep regression", "is this rash normal?". Use this only for questions to bring up; an actual appointment or symptom is health.',
    '- Anything that does not clearly fit bills/events/groceries/health goes in general. Never drop an item.',
    '- Keep titles short and clear. If a message is ambiguous or pure chit-chat, use {"action":"none"}.',
    '- Emit {"action":"rescrape"} when the user asks to retry reading apartment listings. There are currently ' + blockedCount + ' apartment(s) awaiting re-read.',
    'OPEN ITEMS: ' + JSON.stringify(openForModel),
    'APARTMENTS (active — for set_visit / rule_out): ' + JSON.stringify(aptList),
    'RULED OUT (for reactivate): ' + JSON.stringify(ruledList),
    ...(replyApt ? ['REPLIED-TO APARTMENT (this message is a reply to a message about this apartment): ' + JSON.stringify(replyApt) + '. When the user says "this"/"it"/"the apartment" or schedules a visit / rules it out / adds a note without naming which apartment, use apt_id=' + replyApt.id + '.'] : []),
  ].join('\n');

  let ops: any[] = [];
  try {
    const parsed = jsonFrom(await claude(env, sys, `1. [${who}] ${text}`));
    ops = Array.isArray(parsed.ops) ? parsed.ops : [];
  } catch (e: any) {
    console.log('ops parse error:', String(e && e.message || e));
    // silence here would look identical to "nothing to track" — always say the message was lost
    await tgSend(env, '🤖 No pude procesar ese mensaje (error temporal) — envíalo otra vez.', msg.message_id);
    return;
  }

  const now = new Date().toISOString();
  const added: string[] = [];
  const completed: string[] = [];
  const removed: string[] = [];
  const notFound: string[] = [];
  const visitsSet: string[] = [];
  const ruledOut: string[] = [];
  const reactivated: string[] = [];
  const noted: string[] = [];
  const voted: string[] = [];
  let wantQuery = false;
  let wantRescrape = false;
  let wantAptSummary = false;
  for (const op of ops) {
    if (op.action === 'add' && op.title) {
      // ponytail: coerce an unknown/missing category to general so a mis-parse never drops the item
      const cat = (CATEGORIES as readonly string[]).includes(op.category) ? op.category : 'general';
      await run(env,
        `INSERT INTO items (category,title,notes,due_date,recurrence,recur_day,amount,status,created_by,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?, 'open', ?, ?, ?)`,
        cat, String(op.title).slice(0, 120), null,
        op.due_date || null, op.recurrence === 'monthly' ? 'monthly' : 'none',
        op.recur_day || null, op.amount || null, who, now, now);
      let d = '';
      if (op.due_date) d = ' — ' + dueLabel(op.due_date, td).replace(/^⚠️ /, '');
      if (op.recurrence === 'monthly') d += ' (mensual)';
      added.push(`${CAT_EMOJI[cat]} ${op.title}${d}`);
    } else if (op.action === 'complete' && op.id != null) {
      const r = await completeItem(env, Number(op.id));
      if (r.ok) completed.push(`${r.title} ✓${r.next ? ` (próx: ${fmtDate(r.next)})` : ''}`);
      else notFound.push('#' + op.id);
    } else if (op.action === 'remove' && op.id != null) {
      const it = await get(env, 'SELECT * FROM items WHERE id=? AND status=?', Number(op.id), 'open');
      if (it) {
        // status='deleted' — every query filters status='open', so it vanishes everywhere; no migration needed
        await run(env, "UPDATE items SET status='deleted', updated_at=? WHERE id=?", now, it.id);
        removed.push(it.title);
      } else notFound.push('#' + op.id);
    } else if (op.action === 'query') {
      wantQuery = true;
    } else if (op.action === 'rescrape') {
      wantRescrape = true;
    } else if (op.action === 'apt_summary') {
      wantAptSummary = true;
    } else if (op.action === 'set_visit' && op.apt_id != null) {
      const vd = (op.visit_date == null || op.visit_date === '') ? null : String(op.visit_date);
      const arow = await get(env, "SELECT * FROM apartments WHERE id=? AND status='active'", op.apt_id);
      if (arow) {
        await run(env, 'UPDATE apartments SET visit_date=?, updated_at=? WHERE id=?', vd, new Date().toISOString(), op.apt_id);
        const mail = await visitMail(env, arow, vd, arow.visit_date);
        visitsSet.push((arow.location || arow.title || ('apto ' + arow.id)) + (vd ? (' → ' + dueLabel(vd, td) + hhmm(vd)) : ' (visita cancelada)') + mail);
      }
    } else if (op.action === 'rule_out' && op.apt_id != null) {
      const res = await ruleOutApt(env, Number(op.apt_id), op.reason);
      if (res) ruledOut.push(aptName(res.row) + (res.reason ? (' — ' + res.reason) : '') + res.mail);
    } else if (op.action === 'reactivate' && op.apt_id != null) {
      const res = await reactivateApt(env, Number(op.apt_id));
      if (res) reactivated.push(aptName(res.row) + res.mail);
    } else if (op.action === 'apt_vote' && op.apt_id != null && (op.vote === 'up' || op.vote === 'down')) {
      // any status — a verdict on a ruled-out apartment is context for reconsidering it
      const arow = await get(env, 'SELECT * FROM apartments WHERE id=?', op.apt_id);
      if (arow) {
        const voter = canonVoter(who.split(' ')[0]); // Telegram first name → canonical person
        await upsertVote(env, Number(op.apt_id), voter, op.vote);
        voted.push((op.vote === 'up' ? '👍 ' : '👎 ') + aptName(arow) + ' — ' + voterName(voter));
      } else notFound.push('apto #' + op.apt_id);
    } else if (op.action === 'apt_note' && op.apt_id != null && op.note) {
      // any status — recording why a ruled-out apartment was rejected is legit; a miss must not be silent
      const arow = await get(env, "SELECT * FROM apartments WHERE id=?", op.apt_id);
      if (arow) {
        // attributed to the first name of whoever sent the Telegram message
        await appendAptNote(env, Number(op.apt_id), who.split(' ')[0], String(op.note));
        noted.push(aptName(arow) + ' — ' + String(op.note).trim());
      } else notFound.push('apto #' + op.apt_id);
    }
  }

  // build ack
  const lines: string[] = [];
  if (added.length) lines.push('*Anotado:*\n' + added.map(a => '• ' + a).join('\n'));
  if (completed.length) lines.push('*Hecho:*\n' + completed.map(c => '• ' + c).join('\n'));
  if (removed.length) lines.push('🗑 *Quitado:*\n' + removed.map(r => '• ' + r).join('\n'));
  if (notFound.length) lines.push('❓ No encontré ' + notFound.join(', ') + ' — pregunta "¿qué hay pendiente?" para ver la lista.');
  if (visitsSet.length) lines.push('*Visita agendada:*\n' + visitsSet.map(v => '• ' + v).join('\n'));
  if (ruledOut.length) lines.push('🚫 *Descartado(s)* (siguen guardados en la app, sección Descartados):\n' + ruledOut.map(v => '• ' + v).join('\n'));
  if (reactivated.length) lines.push('↩️ *De vuelta en la lista:*\n' + reactivated.map(v => '• ' + v).join('\n'));
  if (noted.length) lines.push('📝 *Nota guardada:*\n' + noted.map(n => '• ' + n).join('\n'));
  if (voted.length) lines.push('*Veredicto guardado:*\n' + voted.map(v => '• ' + v).join('\n'));
  if (wantQuery) {
    lines.push(await buildDigestBody(env, td, 'Esto es lo pendiente:'));
  }
  if (wantAptSummary) {
    lines.push(await buildAptSummary(env));
  }
  if (wantRescrape) {
    const rr = await retryBlockedScrapes(env);
    if (rr.updated.length) {
      lines.unshift('🔄 *Listo — releí ' + rr.updated.length + ' apartamento(s):*\n' + rr.updated.map((u: any) => {
        const loc = u.f.location || u.f.title || ('#' + u.id);
        let pr = money(u.f.price); if (u.dt === 'rent' && pr) pr += '/mes';
        const bits = [pr, u.ppm ? ('≈' + money(u.ppm) + '/m²') : '', u.f.area_m2 ? (u.f.area_m2 + ' m²') : ''].filter(Boolean).join(' · ');
        return '• ' + loc + (bits ? (' — ' + bits) : '') + priceChangeNote(u.priceChange);
      }).join('\n'));
    }
    if (rr.still.length) {
      const hosts = [...new Set(rr.still.map((s: any) => s.host))].join(', ');
      lines.unshift('⚠️ _Sigo sin poder leer: *' + hosts + '*. Puede que la página esté bloqueando el acceso; escribe "reintenta" más tarde para volver a probar._');
    }
    if (!rr.updated.length && !rr.still.length) lines.unshift('_No hay apartamentos pendientes por releer. 👍_');
  }
  if (lines.length) await tgSend(env, lines.join('\n\n'), msg.message_id);
}

// ================= WEB ROUTES =================
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
function html(body: string): Response {
  return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

async function dashboardPage(env: Env): Promise<Response> {
  const td = today();
  const open = await openItems(env);
  const esc = (s: any) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const strip = (s: string) => s.replace('⚠️ ', '');
  const dueCls = (iso: string | null) => {
    if (!iso) return '';
    const n = daysBetween(td, iso);
    return n <= 0 ? 'err' : n === 1 ? 'warn' : '';
  };
  const rowHtml = (i: any, metaOverride?: string) => {
    const rec = i.recurrence === 'monthly' ? '<span class="rec">mensual</span>' : '';
    const meta = metaOverride ?? (i.due_date ? strip(dueLabel(i.due_date, td)) : (i.amount || ''));
    return '<div class="row" id="it' + i.id + '"><span class="title">' + esc(i.title) + rec + '</span>' +
      '<span class="meta ' + dueCls(i.due_date) + '">' + esc(meta) + '</span>' +
      '<button class="done" data-id="' + i.id + '" aria-label="Hecho">✓</button></div>';
  };
  const bills = open.filter((i: any) => i.category === 'bills' && i.due_date);
  const dueBills = bills.filter((b: any) => daysBetween(td, b.due_date) <= 1).sort(byDue);
  let sections = '';
  if (dueBills.length) {
    let rows = '';
    for (const b of dueBills) rows += rowHtml(b, (b.amount ? b.amount + ' · ' : '') + strip(dueLabel(b.due_date, td)));
    sections += '<div class="card attention"><h2>💵 Cuentas por pagar ya<span class="count">' + dueBills.length + '</span></h2>' + rows + '</div>';
  }
  for (const cat of CATEGORIES) {
    const items = open.filter((i: any) => i.category === cat && !(cat === 'bills' && dueBills.some((d: any) => d.id === i.id))).sort(byDue);
    if (!items.length) continue;
    let rows = '';
    for (const i of items) rows += rowHtml(i);
    sections += '<div class="card"><h2>' + CAT_EMOJI[cat] + ' ' + CAT_LABEL[cat] + '<span class="count">' + items.length + '</span></h2>' + rows + '</div>';
  }
  if (!sections) sections = '<div class="card empty">Aún no hay nada — escribe algo al grupo. 🎉</div>';
  const updated = new Intl.DateTimeFormat('es-CO', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date());
  // function replacers: `sections`/amounts contain '$', which String.replace would treat as $&/$'/$$ patterns
  return html(dashboardHtml.replace('{{SECTIONS}}', () => sections).replace('{{UPDATED}}', () => updated));
}

async function homePage(env: Env): Promise<Response> {
  const td = today();
  const open = await openItems(env);
  const dueSoon = open.filter((i: any) => i.due_date && daysBetween(td, i.due_date) <= 1).length;
  const hhMeta = open.length
    ? `${open.length} pendiente${open.length === 1 ? '' : 's'}` + (dueSoon ? ` · ${dueSoon} vence${dueSoon === 1 ? '' : 'n'} ya` : '')
    : 'Nada pendiente 🎉';
  const aptCount = Number((await get(env, "SELECT COUNT(*) c FROM apartments WHERE status='active'"))?.c || 0);
  const nv = await get(env, "SELECT visit_date FROM apartments WHERE status='active' AND visit_date>=? ORDER BY visit_date LIMIT 1", td);
  let aptMeta = aptCount ? `${aptCount} activo${aptCount === 1 ? '' : 's'}` : 'Aún no hay apartamentos';
  if (nv) aptMeta += ` · visita ${fmtDate(nv.visit_date)}${hhmm(nv.visit_date)}`;
  const todayLabel = new Intl.DateTimeFormat('es-CO', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long' }).format(new Date());
  // function replacers: apt meta can carry '$'-containing amounts that String.replace would mangle
  return html(homeHtml.replace('{{TODAY}}', () => todayLabel).replace('{{HH_META}}', () => hhMeta).replace('{{APT_META}}', () => aptMeta));
}

// Cloudflare Access injects the logged-in user's email on every request
function webUser(req: Request): string {
  return (req.headers.get('cf-access-authenticated-user-email') || '').split('@')[0];
}
// pretty note-author name for a web user: known email local-parts → first names, else the raw local-part
const WEB_ALIAS: Record<string, string> = { felipeam86: 'Felipe' };
function webAuthor(req: Request): string {
  const lp = webUser(req);
  if (!lp) return '';
  const s = lp.toLowerCase();
  if (WEB_ALIAS[s]) return WEB_ALIAS[s];
  if (s.includes('felipe')) return 'Felipe';
  if (s.includes('lucia')) return 'Lucía';
  return lp;
}

function manifestResponse(): Response {
  // ponytail: icons as data URIs — Chrome fetches manifest icons without the Access cookie, so plain URLs would 302 to the login page
  const m = {
    name: 'Turikumwe', short_name: 'Turikumwe',
    start_url: '/', scope: '/', display: 'standalone',
    background_color: '#0e1013', theme_color: '#0e1013',
    icons: [
      { src: 'data:image/png;base64,' + ICON_192, sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'data:image/png;base64,' + ICON_512, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'data:image/png;base64,' + ICON_512, sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
  return new Response(JSON.stringify(m), { headers: { 'content-type': 'application/manifest+json' } });
}

function iconResponse(): Response {
  const bytes = Uint8Array.from(atob(ICON_192), (c) => c.charCodeAt(0));
  return new Response(bytes, { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' } });
}

async function itemsAction(env: Env, req: Request, ctx: ExecutionContext): Promise<Response> {
  const b: any = await req.json().catch(() => ({}));
  if (b.action !== 'complete') return json({ ok: false, error: 'unknown action' }, 400);
  const id = Number(b.id);
  if (!id) return json({ ok: false, error: 'missing id' }, 400);
  const r = await completeItem(env, id);
  if (!r.ok) return json({ ok: false, error: 'not-found' }, 404);
  const who = webUser(req);
  // groceries are checked off in bursts at the store — one Telegram ping per item is spam
  if (r.category !== 'groceries') {
    ctx.waitUntil(tgSend(env, `✓ *${r.title}*${r.next ? ` (próx: ${fmtDate(r.next)})` : ''} — vía web${who ? ' · ' + who : ''}`).catch(() => {}));
  }
  return json({ ok: true, next: r.next ? fmtDate(r.next) : null });
}

async function apartmentsData(env: Env, req: Request, ctx: ExecutionContext): Promise<Response> {
  // geocode any new/changed addresses in the background; their pins show on the next load
  ctx.waitUntil(geocodeBackfill(env).catch((e) => console.log('geocode backfill error:', String(e && e.message || e))));
  const rows = await all(env, "SELECT * FROM apartments WHERE status='active' ORDER BY created_at DESC");
  const ruledOut = await all(env, "SELECT * FROM apartments WHERE status='ruled_out' ORDER BY ruled_out_at DESC, updated_at DESC");
  // visit photos, grouped per apartment (active and ruled-out alike); file ids stay server-side
  const photos = await all(env, 'SELECT id, apartment_id, caption, created_at FROM apartment_photos ORDER BY id');
  const byApt: Record<number, any[]> = {};
  for (const p of photos) (byApt[p.apartment_id] = byApt[p.apartment_id] || []).push({ id: p.id, caption: p.caption, created_at: p.created_at });
  for (const r of [...rows, ...ruledOut]) r.photos = byApt[r.id] || [];
  // per-person verdicts, e.g. {felipe:'up', lucia:'down'} — ruled-out rows keep theirs as
  // context for "reconsiderar". `me` tells the frontend whose control is tappable.
  const votes = await all(env, 'SELECT apartment_id, voter, vote FROM apartment_votes');
  const vByApt: Record<number, Record<string, string>> = {};
  for (const v of votes) (vByApt[v.apartment_id] = vByApt[v.apartment_id] || {})[v.voter] = v.vote;
  for (const r of [...rows, ...ruledOut]) r.votes = vByApt[r.id] || {};
  return json({ apartments: rows, ruledOut, today: today(), me: canonVoter(webUser(req)) });
}

// serve a stored visit photo: permanent file_id → short-lived file_path (getFile, expires ~1 h,
// so it's resolved per request and never stored) → stream the bytes. Access guards the route.
// thumb=true serves the mid-size rendition (the strip's 72px squares don't need full res).
async function photoResponse(env: Env, photoId: number, thumb: boolean): Promise<Response> {
  const row = await get(env, 'SELECT tg_file_id, tg_thumb_file_id FROM apartment_photos WHERE id=?', photoId);
  if (!row) return new Response('not found', { status: 404 });
  try {
    const gf = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/getFile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file_id: (thumb && row.tg_thumb_file_id) || row.tg_file_id }),
    });
    const j: any = await gf.json();
    if (!j.ok || !j.result?.file_path) return new Response('telegram getFile failed', { status: 502 });
    const f = await fetch(`https://api.telegram.org/file/bot${env.BOT_TOKEN}/${j.result.file_path}`);
    if (!f.ok || !f.body) return new Response('telegram file fetch failed', { status: 502 });
    return new Response(f.body, {
      headers: {
        'content-type': f.headers.get('content-type') || 'image/jpeg',
        'cache-control': 'private, max-age=86400',
      },
    });
  } catch (e: any) {
    return new Response('telegram error: ' + String(e && e.message || e).slice(0, 80), { status: 502 });
  }
}

async function apartmentsAction(env: Env, req: Request, ctx: ExecutionContext): Promise<Response> {
  const b: any = await req.json().catch(() => ({}));
  const id = Number(b.id);
  if (!id) return json({ ok: false, error: 'missing id' }, 400);
  const who = webUser(req);
  const via = ` — vía web${who ? ' · ' + who : ''}`;
  const echo = (msg: string, markup?: unknown) => ctx.waitUntil(tgSend(env, msg, undefined, markup).catch(() => {}));
  if (b.action === 'set_visit') {
    const vd = (b.visit_date == null || b.visit_date === '') ? null : String(b.visit_date);
    const oldVd = (await get(env, 'SELECT visit_date FROM apartments WHERE id=?', id))?.visit_date || null;
    await run(env, 'UPDATE apartments SET visit_date=?, updated_at=? WHERE id=?', vd, new Date().toISOString(), id);
    const row = await get(env, 'SELECT * FROM apartments WHERE id=?', id);
    if (row) ctx.waitUntil((async () => {
      const mail = await visitMail(env, row, vd, oldVd);
      await tgSend(env, (vd ? `📅 Visita a *${aptName(row)}* → ${fmtDate(vd)}${hhmm(vd)}` : `📅 Visita a *${aptName(row)}* cancelada`) + via + mail);
    })().catch(() => {}));
    return json({ ok: true, row });
  }
  if (b.action === 'invite') {
    // manual re-send from the calendar card, e.g. after editing the address or agent
    const row = await get(env, "SELECT * FROM apartments WHERE id=? AND status='active'", id);
    if (!row) return json({ ok: false, error: 'no encontrado' }, 404);
    if (!row.visit_date) return json({ ok: false, error: 'sin fecha de visita' }, 400);
    if (String(row.visit_date).slice(0, 10) < today()) return json({ ok: false, error: 'la visita ya pasó' }, 400);
    try { await sendInviteMail(env, row, 'REQUEST', String(row.visit_date)); } catch (e: any) {
      console.log('invite mail error:', String(e && e.message || e));
      return json({ ok: false, error: 'no se pudo enviar el correo' }, 502);
    }
    echo(`📧 Invitación de *${aptName(row)}* enviada a los correos${via}`);
    return json({ ok: true });
  }
  if (b.action === 'rule_out') {
    const res = await ruleOutApt(env, id, b.reason); // shared with Telegram ops + callback buttons
    if (!res) return json({ ok: false, error: 'no encontrado' }, 404);
    echo(`🚫 *${mdEscape(aptName(res.row))}* descartado${res.reason ? ' — ' + res.reason : ''}${via}${res.mail}`,
      kb([[{ text: '↩️ Reactivar', callback_data: 're:' + id }]]));
    return json({ ok: true, row: await get(env, 'SELECT * FROM apartments WHERE id=?', id) });
  }
  if (b.action === 'reactivate') {
    const res = await reactivateApt(env, id);
    if (!res) return json({ ok: false, error: 'no encontrado' }, 404);
    echo(`↩️ *${mdEscape(aptName(res.row))}* de vuelta en la lista${via}${res.mail}`);
    return json({ ok: true, row: await get(env, 'SELECT * FROM apartments WHERE id=?', id) });
  }
  if (b.action === 'rescrape') {
    const res = await rescrapeOne(env, id);
    // a price move must reach the group no matter who pressed the button; the JSON carries
    // priceChange too so the frontend can toast it
    if (res.ok && res.priceChange) {
      const prow = await get(env, 'SELECT * FROM apartments WHERE id=?', id);
      const pc = res.priceChange;
      echo(`${pc.to < pc.from ? '⬇️' : '⬆️'} *${mdEscape(aptName(prow))}* ${pc.to < pc.from ? 'bajó' : 'subió'} de ${money(pc.from)} a ${money(pc.to)}${via}`);
    }
    return json({ ...res, row: await get(env, 'SELECT * FROM apartments WHERE id=?', id) });
  }
  if (b.action === 'set_fields') {
    // address / agent / phone / tag — quiet metadata edits, no Telegram echo
    const clean = (v: any) => { const s = (v == null ? '' : String(v)).trim(); return s ? s.slice(0, 200) : null; };
    await run(env, 'UPDATE apartments SET address=?, agent_name=?, agent_phone=?, tag=?, updated_at=? WHERE id=?',
      clean(b.address), clean(b.agent_name), clean(b.agent_phone), clean(b.tag), new Date().toISOString(), id);
    // a new/changed address gets geocoded right away, so the map pin appears on the reload
    const grow = await get(env, 'SELECT id, address, geo_address FROM apartments WHERE id=?', id);
    if (grow?.address && grow.address !== grow.geo_address) await geocodeApt(env, grow);
    return json({ ok: true, row: await get(env, 'SELECT * FROM apartments WHERE id=?', id) });
  }
  if (b.action === 'edit') {
    // generic single-field edit — lets the table fill in any field by hand for listings that can't be scraped
    const FIELDS: Record<string, 'int' | 'real' | 'text' | 'deal'> = {
      location: 'text', title: 'text', deal_type: 'deal',
      price: 'int', admin_fee: 'int', bedrooms: 'int', bathrooms: 'int',
      area_m2: 'real', stratum: 'int', parking: 'int',
      address: 'text', agent_name: 'text', agent_phone: 'text', tag: 'text',
    };
    const field = String(b.field || '');
    const kind = FIELDS[field];
    if (!kind) return json({ ok: false, error: 'bad field' }, 400);
    let val: any = b.value;
    if (kind === 'text') { const s = (val == null ? '' : String(val)).trim(); val = s ? s.slice(0, 300) : null; }
    else if (kind === 'deal') { val = (val === 'buy' || val === 'rent') ? val : 'unknown'; }
    else if (kind === 'int') { const d = String(val == null ? '' : val).replace(/[^\d-]/g, ''); val = (d === '' || d === '-') ? null : parseInt(d, 10); } // strip COP thousands dots
    else { const d = String(val == null ? '' : val).replace(',', '.').replace(/[^\d.-]/g, ''); val = d === '' ? null : parseFloat(d); if (val != null && isNaN(val)) val = null; }
    // field is an allowlisted column name (see FIELDS), so the interpolation is injection-safe
    await run(env, `UPDATE apartments SET ${field}=?, updated_at=? WHERE id=?`, val, new Date().toISOString(), id);
    // $/m² for a sale is stored (price_per_m2); recompute it whenever price or area changes
    if (field === 'price' || field === 'area_m2') {
      const row = await get(env, 'SELECT price, area_m2 FROM apartments WHERE id=?', id);
      const ppm = (row && row.price && row.area_m2 > 0) ? Math.round(Number(row.price) / Number(row.area_m2)) : null;
      await run(env, 'UPDATE apartments SET price_per_m2=? WHERE id=?', ppm, id);
    }
    // a hand-typed price is a correction, not a market move — drop any «bajó/subió» record so
    // the UI never flags a change the market didn't make
    if (field === 'price') await run(env, 'UPDATE apartments SET prev_price=NULL, price_changed_at=NULL WHERE id=?', id);
    // same as set_fields: an address typed into the table cell gets its map pin right away
    if (field === 'address' && val) {
      const grow = await get(env, 'SELECT id, address, geo_address FROM apartments WHERE id=?', id);
      if (grow?.address && grow.address !== grow.geo_address) await geocodeApt(env, grow);
    }
    return json({ ok: true, row: await get(env, 'SELECT * FROM apartments WHERE id=?', id) });
  }
  if (b.action === 'vote') {
    // the voter is ALWAYS the logged-in Access user — never trusted from the body
    const voter = canonVoter(webUser(req));
    if (!voter) return json({ ok: false, error: 'sin usuario' }, 403);
    const vote = b.vote === 'up' || b.vote === 'down' ? b.vote : null;
    const row = await get(env, 'SELECT * FROM apartments WHERE id=?', id);
    if (!row) return json({ ok: false, error: 'no encontrado' }, 404);
    if (vote === null) {
      await run(env, 'DELETE FROM apartment_votes WHERE apartment_id=? AND voter=?', id, voter); // quiet on clear
    } else {
      await upsertVote(env, id, voter, vote);
      // b.quiet: the post-visit follow-up buttons pair this with an apt_note that already echoes
      if (!b.quiet) echo(vote === 'up'
        ? `👍 A ${voterName(voter)} le gustó *${mdEscape(aptName(row))}*`
        : `👎 A ${voterName(voter)} no le convenció *${mdEscape(aptName(row))}*`);
    }
    return json({ ok: true });
  }
  if (b.action === 'apt_note') {
    const note = (b.note && String(b.note).trim()) ? String(b.note).trim().slice(0, 300) : null;
    if (!note) return json({ ok: false, error: 'empty note' }, 400);
    await appendAptNote(env, id, webAuthor(req), note);
    const row = await get(env, 'SELECT * FROM apartments WHERE id=?', id);
    if (row) echo(`📝 Nota en *${aptName(row)}*: ${note}${via}`);
    return json({ ok: true, row });
  }
  if (b.action === 'apt_note_del') {
    // remove one exact note line (mis-parsed notes shouldn't live forever); quiet cleanup, no Telegram echo
    const line = String(b.line || '');
    if (!line) return json({ ok: false, error: 'missing line' }, 400);
    const row = await get(env, 'SELECT notes FROM apartments WHERE id=?', id);
    if (!row) return json({ ok: false, error: 'not-found' }, 404);
    const noteLines = String(row.notes || '').split('\n');
    const idx = noteLines.indexOf(line);
    if (idx < 0) return json({ ok: false, error: 'note line not found' }, 404);
    noteLines.splice(idx, 1);
    const rest = noteLines.join('\n');
    await run(env, 'UPDATE apartments SET notes=?, updated_at=? WHERE id=?', rest.trim() ? rest : null, new Date().toISOString(), id);
    return json({ ok: true, row: await get(env, 'SELECT * FROM apartments WHERE id=?', id) });
  }
  return json({ ok: false, error: 'unknown action' }, 400);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === '/telegram-webhook' && req.method === 'POST') {
      if (req.headers.get('x-telegram-bot-api-secret-token') !== env.TG_WEBHOOK_SECRET) {
        return new Response('forbidden', { status: 403 });
      }
      const update = await req.json().catch(() => null);
      // ack immediately so Telegram doesn't retry while we scrape / call Claude
      if (update) ctx.waitUntil(handleUpdate(env, update).catch((e) => console.log('webhook error:', String(e && e.message || e))));
      return new Response('ok');
    }

    if (req.method === 'GET' && path === '/') return homePage(env);
    if (req.method === 'GET' && path === '/dashboard.html') return dashboardPage(env);
    if (req.method === 'GET' && path === '/apartments.html') return html(apartmentsHtml);
    if (req.method === 'GET' && path === '/apartments-data.json') return apartmentsData(env, req, ctx);
    const photoM = path.match(/^\/apt-photo\/(\d+)$/);
    if (req.method === 'GET' && photoM) return photoResponse(env, Number(photoM[1]), url.searchParams.get('s') === 't');
    if (req.method === 'GET' && path === '/manifest.json') return manifestResponse();
    if (req.method === 'GET' && path === '/icon.png') return iconResponse();
    if (req.method === 'POST' && path === '/apartments-action') return apartmentsAction(env, req, ctx);
    if (req.method === 'POST' && path === '/items-action') return itemsAction(env, req, ctx);

    return new Response('not found', { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    // Explicit dispatch per cron — keep the strings in sync with [triggers] in wrangler.toml:
    //   '30 12 * * *' = 07:30 Bogota morning digest
    //   '0 0 * * *'   = 19:00 Bogota evening: still-due nudge + post-visit follow-up
    //   '0 * * * *'   = hourly visit reminders (~1 h before each timed visit)
    // At 00:00 UTC the evening and hourly crons both fire, as two separate invocations — fine.
    switch (controller.cron) {
      case '30 12 * * *': await sendDigest(env); return;
      case '0 0 * * *': await sendEveningReminder(env); await sendPostVisitFollowup(env); return;
      case '0 * * * *': await sendVisitReminders(env); return;
      default: console.log('unknown cron:', controller.cron); // never guess — a wrong guess spams the group
    }
  },
} satisfies ExportedHandler<Env>;
