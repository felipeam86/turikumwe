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
// decode the handful of HTML entities that appear in scraped attribute URLs (&amp; splits query params)
function decodeHtml(s: string): string {
  return s.replace(/&amp;/g, '&').replace(/&#0*38;/g, '&').replace(/&quot;/g, '"').replace(/&#0*39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
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
async function tgSend(env: Env, text: string, replyTo?: number) {
  const send = (payload: Record<string, unknown>) =>
    fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  const reply = replyTo ? { reply_to_message_id: replyTo, allow_sending_without_reply: true } : {};
  const r = await send({ chat_id: env.GROUP_CHAT_ID, text, parse_mode: 'Markdown', ...reply });
  // ponytail: if legacy-Markdown parsing rejects the text, resend plain rather than dropping the ack
  if (!r.ok) await send({ chat_id: env.GROUP_CHAT_ID, text, ...reply });
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
  '• Apartamentos: responde al mensaje del apto y di "visita el martes a las 10am" y agendo la visita con hora; también "agenda visita al apto 2 el sábado 3pm", "descarta el de Cedritos", "reactiva el apto 1", "el de Chicó nos gustó" (queda como nota), "reintenta" (relee links bloqueados).',
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
      return { reread: true, id: existing.id, ok: rr.ok, blocked: rr.blocked, name: aptName(existing) };
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

async function applyScrapedFields(env: Env, row: any, scr: any): Promise<{ f: any, dt: string, ppm: number | null }> {
  const input = 'USER MESSAGE:\n' + (row.raw_note || '') + '\n\nSCRAPED EVIDENCE (ok from ' + scr.host + '):\n' + scr.evidence;
  const f = await extractFields(env, input);
  const dt = (f.deal_type === 'buy' || f.deal_type === 'rent') ? f.deal_type : (row.deal_type || 'unknown');
  const ppm = (f.price && f.area_m2 && f.area_m2 > 0) ? Math.round(Number(f.price) / Number(f.area_m2)) : row.price_per_m2;
  const now = new Date().toISOString();
  await run(env,
    "UPDATE apartments SET deal_type=?,title=?,price=?,admin_fee=?,bedrooms=?,bathrooms=?,area_m2=?,price_per_m2=?,parking=?,stratum=?,location=?,year_built=?,amenities=?,image_url=?,scrape_status='ok',updated_at=? WHERE id=?",
    dt, f.title || row.title, f.price ?? row.price, f.admin_fee ?? row.admin_fee, f.bedrooms ?? row.bedrooms, f.bathrooms ?? row.bathrooms, f.area_m2 ?? row.area_m2, ppm, f.parking ?? row.parking, f.stratum ?? row.stratum, f.location || row.location, f.year_built ?? row.year_built, f.amenities || row.amenities, scr.image || row.image_url, now, row.id);
  return { f, dt, ppm };
}

async function rescrapeOne(env: Env, id: number): Promise<any> {
  const row = await get(env, 'SELECT * FROM apartments WHERE id=?', id);
  if (!row) return { ok: false, error: 'not-found' };
  const scr = await scrapeListing(row.url);
  if (!scr.ok) {
    await run(env, 'UPDATE apartments SET scrape_status=?, updated_at=? WHERE id=?', scr.blocked || 'error', new Date().toISOString(), id);
    return { ok: false, id, blocked: scr.blocked, host: scr.host };
  }
  await applyScrapedFields(env, row, scr);
  return { ok: true, id };
}

async function retryBlockedScrapes(env: Env): Promise<{ updated: any[], still: any[] }> {
  const rows = await all(env, "SELECT * FROM apartments WHERE status='active' AND scrape_status IS NOT NULL AND scrape_status!='ok'");
  const updated: any[] = []; const still: any[] = [];
  for (const row of rows) {
    tgTyping(env); // each scrape can take up to 15s; keep the indicator alive per row
    const scr = await scrapeListing(row.url);
    if (!scr.ok) { still.push({ host: scr.host, blocked: scr.blocked }); continue; }
    const { f, dt, ppm } = await applyScrapedFields(env, row, scr);
    updated.push({ id: row.id, f, ppm, dt });
  }
  return { updated, still };
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
    lines.push('_No pude leer la página automáticamente (' + rec.scr.blocked + '). Guardé lo que escribiste; escribe "reintenta" para volver a probar._');
  }
  lines.push('Míralo en la app → pantalla *Apartamentos*.');
  return lines.join('\n');
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
  const visits = await all(env, "SELECT location, title, source_site, id, visit_date FROM apartments WHERE status='active' AND visit_date>=? ORDER BY visit_date", td);
  if (visits.length) {
    out.push('🏢 *Visitas de apartamentos:*\n' + visits.map((v: any) =>
      `• ${aptName(v)} — ${stripWarn(dueLabel(v.visit_date, td))}${hhmm(v.visit_date)}`).join('\n'));
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
async function handleUpdate(env: Env, update: any) {
  const msg = update?.message;
  const text = String(msg?.text || '').trim();
  if (!msg || !text) return;
  if (String(msg.chat?.id) !== String(env.GROUP_CHAT_ID)) return;
  const who = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || 'group';
  const td = today();

  // any /command → help (it's just the two of them; no BotFather registration needed)
  if (text.startsWith('/')) {
    await tgSend(env, HELP, msg.message_id);
    return;
  }

  // URL message → apartment ingestion only
  if (URL_RE.test(text)) {
    const acks: string[] = [];
    for (const u of extractUrls(text)) {
      tgTyping(env);
      try {
        const rec = await ingestApartment(env, u, text, who);
        if (rec.reread) {
          acks.push(rec.ok
            ? '🔄 Ya lo tenías (#' + rec.id + ') y no se había podido leer — lo releí ahora. Míralo en la app.'
            : '🔁 Ya lo tenías guardado: *' + rec.name + '* #' + rec.id + '. Sigo sin poder leer la página (' + (rec.blocked || 'error') + ').');
        } else if (rec.dup) {
          const st = rec.status === 'ruled_out' ? ' — estaba *descartado*' + (rec.reason ? ' (' + rec.reason + ')' : '') : '';
          acks.push('🔁 Ya lo tenías guardado: *' + rec.name + '* #' + rec.id + st + '.');
        } else if (rec.skipped) {
          acks.push('🔗 Ese link no parece un anuncio de apartamento — no lo guardé. Si sí lo es, reenvíalo diciendo que es un apto.');
        } else {
          acks.push(apartmentAck(rec));
        }
      } catch (e: any) {
        acks.push('No pude guardar un apartamento (' + String(e && e.message || e).slice(0, 80) + ').');
      }
    }
    // household text riding along with a URL is not parsed — say so instead of dropping it silently
    const rest = text.replace(new RegExp(URL_RE.source, 'gi'), '').trim();
    if (rest.length > 30) acks.push('_Ojo: en mensajes con link solo guardo el apartamento — si había algo más que anotar, envíalo aparte._');
    if (acks.length) await tgSend(env, acks.join('\n\n'), msg.message_id);
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
  let wantQuery = false;
  let wantRescrape = false;
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
    } else if (op.action === 'set_visit' && op.apt_id != null) {
      const vd = (op.visit_date == null || op.visit_date === '') ? null : String(op.visit_date);
      const arow = await get(env, "SELECT * FROM apartments WHERE id=? AND status='active'", op.apt_id);
      if (arow) {
        await run(env, 'UPDATE apartments SET visit_date=?, updated_at=? WHERE id=?', vd, new Date().toISOString(), op.apt_id);
        const mail = await visitMail(env, arow, vd, arow.visit_date);
        visitsSet.push((arow.location || arow.title || ('apto ' + arow.id)) + (vd ? (' → ' + dueLabel(vd, td) + hhmm(vd)) : ' (visita cancelada)') + mail);
      }
    } else if (op.action === 'rule_out' && op.apt_id != null) {
      const arow = await get(env, "SELECT * FROM apartments WHERE id=? AND status='active'", op.apt_id);
      if (arow) {
        const reason = (op.reason && String(op.reason).trim()) ? String(op.reason).trim().slice(0, 120) : null;
        const rnow = new Date().toISOString();
        await run(env, "UPDATE apartments SET status='ruled_out', ruled_out_reason=?, ruled_out_at=?, updated_at=? WHERE id=?", reason, rnow, rnow, op.apt_id);
        const mail = await visitMail(env, arow, null, arow.visit_date); // pending visit? tell the calendars it's off
        ruledOut.push((arow.location || arow.title || ('apto ' + arow.id)) + (reason ? (' — ' + reason) : '') + mail);
      }
    } else if (op.action === 'reactivate' && op.apt_id != null) {
      const arow = await get(env, "SELECT * FROM apartments WHERE id=? AND status='ruled_out'", op.apt_id);
      if (arow) {
        await run(env, "UPDATE apartments SET status='active', ruled_out_reason=NULL, ruled_out_at=NULL, updated_at=? WHERE id=?", new Date().toISOString(), op.apt_id);
        const mail = await visitMail(env, arow, arow.visit_date, null); // pending visit comes back → re-invite
        reactivated.push((arow.location || arow.title || ('apto ' + arow.id)) + mail);
      }
    } else if (op.action === 'apt_note' && op.apt_id != null && op.note) {
      // any status — recording why a ruled-out apartment was rejected is legit; a miss must not be silent
      const arow = await get(env, "SELECT * FROM apartments WHERE id=?", op.apt_id);
      if (arow) {
        const note = td + ': ' + String(op.note).trim().slice(0, 300);
        await run(env, "UPDATE apartments SET notes=COALESCE(notes||char(10),'')||?, updated_at=? WHERE id=?", note, new Date().toISOString(), op.apt_id);
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
  if (wantQuery) {
    lines.push(await buildDigestBody(env, td, 'Esto es lo pendiente:'));
  }
  if (wantRescrape) {
    const rr = await retryBlockedScrapes(env);
    if (rr.updated.length) {
      lines.unshift('🔄 *Listo — releí ' + rr.updated.length + ' apartamento(s):*\n' + rr.updated.map((u: any) => {
        const loc = u.f.location || u.f.title || ('#' + u.id);
        let pr = money(u.f.price); if (u.dt === 'rent' && pr) pr += '/mes';
        const bits = [pr, u.ppm ? ('≈' + money(u.ppm) + '/m²') : '', u.f.area_m2 ? (u.f.area_m2 + ' m²') : ''].filter(Boolean).join(' · ');
        return '• ' + loc + (bits ? (' — ' + bits) : '');
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

async function apartmentsData(env: Env): Promise<Response> {
  const rows = await all(env, "SELECT * FROM apartments WHERE status='active' ORDER BY created_at DESC");
  const ruledOut = await all(env, "SELECT * FROM apartments WHERE status='ruled_out' ORDER BY ruled_out_at DESC, updated_at DESC");
  return json({ apartments: rows, ruledOut, today: today() });
}

async function apartmentsAction(env: Env, req: Request, ctx: ExecutionContext): Promise<Response> {
  const b: any = await req.json().catch(() => ({}));
  const id = Number(b.id);
  if (!id) return json({ ok: false, error: 'missing id' }, 400);
  const who = webUser(req);
  const via = ` — vía web${who ? ' · ' + who : ''}`;
  const echo = (msg: string) => ctx.waitUntil(tgSend(env, msg).catch(() => {}));
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
    const reason = (b.reason && String(b.reason).trim()) ? String(b.reason).trim().slice(0, 120) : null;
    const now = new Date().toISOString();
    await run(env, "UPDATE apartments SET status='ruled_out', ruled_out_reason=?, ruled_out_at=?, updated_at=? WHERE id=?", reason, now, now, id);
    const row = await get(env, 'SELECT * FROM apartments WHERE id=?', id);
    if (row) ctx.waitUntil((async () => {
      const mail = await visitMail(env, row, null, row.visit_date); // pending visit? tell the calendars it's off
      await tgSend(env, `🚫 *${aptName(row)}* descartado${reason ? ' — ' + reason : ''}${via}${mail}`);
    })().catch(() => {}));
    return json({ ok: true, row });
  }
  if (b.action === 'reactivate') {
    await run(env, "UPDATE apartments SET status='active', ruled_out_reason=NULL, ruled_out_at=NULL, updated_at=? WHERE id=?", new Date().toISOString(), id);
    const row = await get(env, 'SELECT * FROM apartments WHERE id=?', id);
    if (row) ctx.waitUntil((async () => {
      const mail = await visitMail(env, row, row.visit_date, null); // pending visit comes back → re-invite
      await tgSend(env, `↩️ *${aptName(row)}* de vuelta en la lista${via}${mail}`);
    })().catch(() => {}));
    return json({ ok: true, row });
  }
  if (b.action === 'rescrape') {
    const res = await rescrapeOne(env, id);
    return json({ ...res, row: await get(env, 'SELECT * FROM apartments WHERE id=?', id) });
  }
  if (b.action === 'set_fields') {
    // address / agent / phone / tag — quiet metadata edits, no Telegram echo
    const clean = (v: any) => { const s = (v == null ? '' : String(v)).trim(); return s ? s.slice(0, 200) : null; };
    await run(env, 'UPDATE apartments SET address=?, agent_name=?, agent_phone=?, tag=?, updated_at=? WHERE id=?',
      clean(b.address), clean(b.agent_name), clean(b.agent_phone), clean(b.tag), new Date().toISOString(), id);
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
    return json({ ok: true, row: await get(env, 'SELECT * FROM apartments WHERE id=?', id) });
  }
  if (b.action === 'apt_note') {
    const note = (b.note && String(b.note).trim()) ? String(b.note).trim().slice(0, 300) : null;
    if (!note) return json({ ok: false, error: 'empty note' }, 400);
    const stamped = today() + ': ' + note;
    await run(env, "UPDATE apartments SET notes=COALESCE(notes||char(10),'')||?, updated_at=? WHERE id=?", stamped, new Date().toISOString(), id);
    const row = await get(env, 'SELECT * FROM apartments WHERE id=?', id);
    if (row) echo(`📝 Nota en *${aptName(row)}*: ${note}${via}`);
    return json({ ok: true, row });
  }
  return json({ ok: false, error: 'unknown action' }, 400);
}

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(req.url).pathname;

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
    if (req.method === 'GET' && path === '/apartments-data.json') return apartmentsData(env);
    if (req.method === 'GET' && path === '/manifest.json') return manifestResponse();
    if (req.method === 'GET' && path === '/icon.png') return iconResponse();
    if (req.method === 'POST' && path === '/apartments-action') return apartmentsAction(env, req, ctx);
    if (req.method === 'POST' && path === '/items-action') return itemsAction(env, req, ctx);

    return new Response('not found', { status: 404 });
  },

  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    // '0 0 * * *' = the 19:00-Bogota evening cron in wrangler.toml; keep both strings in sync.
    // Any other trigger (the 07:30 morning cron) sends the full digest.
    if (controller.cron === '0 0 * * *') { await sendEveningReminder(env); return; }
    await sendDigest(env);
  },
} satisfies ExportedHandler<Env>;
