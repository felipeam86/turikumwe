import dashboardHtml from './dashboard.html';
import apartmentsHtml from './apartments.html';

export interface Env {
  DB: D1Database;
  BOT_TOKEN: string;
  TG_WEBHOOK_SECRET: string;
  ANTHROPIC_API_KEY: string;
  GROUP_CHAT_ID: string;
}

const TZ = 'America/Bogota'; // UTC-5, no DST
const MODEL = 'claude-sonnet-5';

const CATEGORIES = ['bills', 'groceries', 'baby', 'pediatrician', 'health', 'general'] as const;
const CAT_LABEL: Record<string, string> = {
  bills: 'Bills', groceries: 'Groceries', baby: 'Baby',
  pediatrician: 'Pediatrician Qs', health: 'Health', general: 'General',
};
const CAT_EMOJI: Record<string, string> = {
  bills: '💵', groceries: '🛒', baby: '👶', pediatrician: '🩺', health: '❤️', general: '📌',
};

// ---- date helpers ----
function today(): string {
  // en-CA gives YYYY-MM-DD
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
function weekday(): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'long' }).format(new Date());
}
function daysBetween(fromISO: string, toISO: string): number {
  const a = Date.parse(fromISO + 'T00:00:00Z');
  const b = Date.parse(toISO + 'T00:00:00Z');
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
  const [y, m, d] = iso.split('-').map(Number);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1];
  return `${mon} ${d}`;
}
function dueLabel(dueISO: string, todayISO: string): string {
  const n = daysBetween(todayISO, dueISO);
  if (n < 0) return `⚠️ overdue ${-n}d (was ${fmtDate(dueISO)})`;
  if (n === 0) return `⚠️ due TODAY (${fmtDate(dueISO)})`;
  if (n === 1) return `due tomorrow (${fmtDate(dueISO)})`;
  return `due ${fmtDate(dueISO)}`;
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

// ---- telegram ----
async function tgSend(env: Env, text: string) {
  const send = (payload: Record<string, unknown>) =>
    fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  const r = await send({ chat_id: env.GROUP_CHAT_ID, text, parse_mode: 'Markdown' });
  // ponytail: if legacy-Markdown parsing rejects the text, resend plain rather than dropping the ack
  if (!r.ok) await send({ chat_id: env.GROUP_CHAT_ID, text });
}

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
    return { ok: true, evidence, host: siteOf(url) };
  } catch (e: any) {
    return { ok: false, blocked: 'error', error: String(e && e.message || e), host: siteOf(url) };
  }
}

const EXTRACT_SYS = [
  'You extract structured data about ONE real-estate listing in Colombia (prices in COP).',
  'You get the message the user typed AND scraped evidence from the listing page (may be empty).',
  'Prefer the scraped evidence; fill gaps from the user message. Use null when unknown - never guess.',
  'Parse Colombian formats: "$1.600.000" = 1600000; "2.5M"/"2,5 millones" = 2500000; "65 m2" = 65. admin/administracion = monthly HOA fee.',
  'Return ONLY JSON: {"title":str|null,"price":int|null,"admin_fee":int|null,"bedrooms":int|null,"bathrooms":int|null,"area_m2":number|null,"parking":int|null,"stratum":int|null,"location":str|null,"year_built":int|null,"amenities":str|null,"deal_type":"buy"|"rent"|"unknown"}.',
  'price = monthly rent (rent) or sale price (buy). location = neighborhood + city. amenities = short comma list if notable.',
].join('\n');

async function extractFields(env: Env, input: string): Promise<any> {
  try {
    return jsonFrom(await claude(env, EXTRACT_SYS, input));
  } catch { return {}; }
}

async function ingestApartment(env: Env, url: string, msgText: string, who: string): Promise<any> {
  const deal = classifyDeal(msgText);
  const scr = await scrapeListing(url);
  const input = 'USER MESSAGE:\n' + (msgText || '') + '\n\nDEAL HINT: ' + deal + '\n\nSCRAPED EVIDENCE (' + (scr.ok ? ('ok from ' + scr.host) : ('UNAVAILABLE: ' + scr.blocked)) + '):\n' + (scr.ok ? scr.evidence : '(none)');
  const f = await extractFields(env, input);
  const dt = (f.deal_type === 'buy' || f.deal_type === 'rent') ? f.deal_type : (deal !== 'unknown' ? deal : 'unknown');
  const ppm = (f.price && f.area_m2 && f.area_m2 > 0) ? Math.round(Number(f.price) / Number(f.area_m2)) : null;
  const now = new Date().toISOString();
  const res = await run(env,
    "INSERT INTO apartments (url,deal_type,title,price,admin_fee,bedrooms,bathrooms,area_m2,price_per_m2,parking,stratum,location,year_built,amenities,source_site,raw_note,scrape_status,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'active',?,?,?)",
    url, dt, f.title || null, f.price || null, f.admin_fee || null, f.bedrooms || null, f.bathrooms || null, f.area_m2 || null, ppm, f.parking || null, f.stratum || null, f.location || null, f.year_built || null, f.amenities || null, scr.host || siteOf(url), msgText || null, scr.ok ? 'ok' : scr.blocked, who || 'group', now, now);
  return { id: res.meta.last_row_id, deal: dt, f, ppm, scr };
}

async function applyScrapedFields(env: Env, row: any, scr: any): Promise<{ f: any, dt: string, ppm: number | null }> {
  const input = 'USER MESSAGE:\n' + (row.raw_note || '') + '\n\nSCRAPED EVIDENCE (ok from ' + scr.host + '):\n' + scr.evidence;
  const f = await extractFields(env, input);
  const dt = (f.deal_type === 'buy' || f.deal_type === 'rent') ? f.deal_type : (row.deal_type || 'unknown');
  const ppm = (f.price && f.area_m2 && f.area_m2 > 0) ? Math.round(Number(f.price) / Number(f.area_m2)) : row.price_per_m2;
  const now = new Date().toISOString();
  await run(env,
    "UPDATE apartments SET deal_type=?,title=?,price=?,admin_fee=?,bedrooms=?,bathrooms=?,area_m2=?,price_per_m2=?,parking=?,stratum=?,location=?,year_built=?,amenities=?,scrape_status='ok',updated_at=? WHERE id=?",
    dt, f.title || row.title, f.price ?? row.price, f.admin_fee ?? row.admin_fee, f.bedrooms ?? row.bedrooms, f.bathrooms ?? row.bathrooms, f.area_m2 ?? row.area_m2, ppm, f.parking ?? row.parking, f.stratum ?? row.stratum, f.location || row.location, f.year_built ?? row.year_built, f.amenities || row.amenities, now, row.id);
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
  const dueBills = bills.filter((b: any) => daysBetween(td, b.due_date) <= 1)
    .sort((a: any, b: any) => a.due_date < b.due_date ? -1 : 1);
  if (dueBills.length) {
    out.push('💵 *Bills needing attention:*\n' + dueBills.map((b: any) =>
      `• ${b.title}${b.amount ? (' (' + b.amount + ')') : ''} — ${dueLabel(b.due_date, td)}`).join('\n'));
  }
  // everything else by category
  for (const cat of CATEGORIES) {
    const items = open.filter((i: any) => i.category === cat && !(cat === 'bills' && dueBills.some((d: any) => d.id === i.id)));
    if (!items.length) continue;
    const rows = items.map((i: any) => {
      let s = '• ' + i.title;
      if (i.due_date) s += ' — ' + dueLabel(i.due_date, td);
      else if (i.amount) s += ' (' + i.amount + ')';
      return s;
    });
    out.push(`${CAT_EMOJI[cat]} *${CAT_LABEL[cat]}:*\n` + rows.join('\n'));
  }
  if (out.length === 1) out.push('_All clear — nothing pending. 🎉_');
  return out.join('\n\n');
}

async function sendDigest(env: Env) {
  const td = today();
  const wd = weekday();
  const body = await buildDigestBody(env, td, `🏠 *Household check-in — ${wd} ${fmtDate(td)}*`);
  // stamp reminders so we know they were surfaced
  await run(env, "UPDATE items SET last_reminded=? WHERE status='open' AND due_date IS NOT NULL AND category='bills'", td);
  await tgSend(env, body);
}

// ================= TELEGRAM UPDATE PROCESSING =================
async function handleUpdate(env: Env, update: any) {
  const msg = update?.message;
  const text = String(msg?.text || '').trim();
  if (!msg || !text) return;
  if (String(msg.chat?.id) !== String(env.GROUP_CHAT_ID)) return;
  const who = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || 'group';
  const td = today();

  // URL message → apartment ingestion only
  if (URL_RE.test(text)) {
    const acks: string[] = [];
    for (const u of extractUrls(text)) {
      try {
        const rec = await ingestApartment(env, u, text, who);
        acks.push(apartmentAck(rec));
      } catch (e: any) {
        acks.push('No pude guardar un apartamento (' + String(e && e.message || e).slice(0, 80) + ').');
      }
    }
    if (acks.length) await tgSend(env, acks.join('\n\n'));
    return;
  }

  // plain message → Claude ops
  const wd = weekday();
  const open = await openItems(env);
  const openForModel = open.map((i: any) => ({ id: i.id, category: i.category, title: i.title, due_date: i.due_date }));
  const blockedCount = (await get(env, "SELECT COUNT(*) c FROM apartments WHERE status='active' AND scrape_status!='ok'"))?.c || 0;
  const aptList = (await all(env, "SELECT id, location, title, deal_type, visit_date FROM apartments WHERE status='active' ORDER BY created_at DESC")).map((a: any) => ({ id: a.id, name: (a.location || a.title || ('apto ' + a.id)), deal: a.deal_type, visit: a.visit_date }));
  const ruledList = (await all(env, "SELECT id, location, title, deal_type FROM apartments WHERE status='ruled_out' ORDER BY updated_at DESC")).map((a: any) => ({ id: a.id, name: (a.location || a.title || ('apto ' + a.id)), deal: a.deal_type }));

  const sys = [
    'You are the parser for a household logging assistant used by a couple in a Telegram group to track home life.',
    `Today is ${td} (${wd}) in the household timezone. Convert incoming messages into structured operations.`,
    'Categories: bills, groceries, baby, pediatrician, health, general.',
    'Return ONLY a JSON object: {"ops":[...]}. No prose, no code fences.',
    'Each op is exactly one of:',
    '  {"action":"add","category":"<cat>","title":"<short label>","due_date":"YYYY-MM-DD"|null,"recurrence":"monthly"|"none","recur_day":<1-31>|null,"amount":"<string>"|null}',
    '  {"action":"complete","id":<id from OPEN ITEMS>}',
    '  {"action":"query"}   (user is asking what is pending / what is on the list)',
    '  {"action":"none"}    (chit-chat, greeting, nothing to track)',
    '  {"action":"rescrape"} (user asks to retry reading an apartment listing that could not be read automatically: "reintenta", "vuelve a intentar el scraping", "intenta de nuevo")',
    '  {"action":"set_visit","apt_id":<id from APARTMENTS>,"visit_date":"YYYY-MM-DD"|null} (user schedules a visit to an apartment: "voy a visitar el de Chico Norte el sábado", "la visita del apto 2 es el 20", "agenda visita apto 1 mañana"; use visit_date=null to cancel a visit)',
    '  {"action":"rule_out","apt_id":<id from APARTMENTS>,"reason":"<short reason>"|null} (user wants to discard / stop considering an apartment: "descarta el apto 2", "ya no me interesa el de Chico Norte", "quita el más caro", "bájalo de la lista", "rule out the Cedritos one"; if they say why, capture a short reason like "muy caro", "muy lejos", "sin parqueadero")',
    '  {"action":"reactivate","apt_id":<id from RULED OUT>} (user wants to reconsider a previously discarded apartment: "vuelve a considerar el apto 2", "reactiva el de Chico Norte", "devuelve el descartado a la lista")',
    'Rules:',
    '- One message may produce several ops (e.g. "low on diapers and formula" => two grocery adds).',
    '- Bills that recur (rent, mortgage, utilities, subscriptions, internet, phone): recurrence="monthly", recur_day=the day-of-month it is due, due_date=the NEXT upcoming occurrence (YYYY-MM-DD). One-off bills: recurrence="none", set due_date.',
    '- Convert every relative date to an absolute YYYY-MM-DD, choosing the next upcoming occurrence. "the 20th" => 20th of this month if still ahead, else next month.',
    '- To mark something done/paid/bought, use "complete" with the matching OPEN ITEM id ("rent paid", "got the diapers", "done with the pharmacy run").',
    '- Grocery titles are just the item ("diapers", "formula"). Pediatrician items are the question to ask the doctor.',
    '- Keep titles short and clear. If a message is ambiguous or pure chit-chat, use {"action":"none"}.',
    '- Emit {"action":"rescrape"} when the user asks to retry reading apartment listings. There are currently ' + blockedCount + ' apartment(s) awaiting re-read.',
    'OPEN ITEMS: ' + JSON.stringify(openForModel),
    'APARTMENTS (active — for set_visit / rule_out): ' + JSON.stringify(aptList),
    'RULED OUT (for reactivate): ' + JSON.stringify(ruledList),
  ].join('\n');

  let ops: any[] = [];
  try {
    const parsed = jsonFrom(await claude(env, sys, `1. [${who}] ${text}`));
    ops = Array.isArray(parsed.ops) ? parsed.ops : [];
  } catch (e: any) {
    console.log('ops parse error:', String(e && e.message || e));
    return;
  }

  const now = new Date().toISOString();
  const added: string[] = [];
  const completed: string[] = [];
  const visitsSet: string[] = [];
  const ruledOut: string[] = [];
  const reactivated: string[] = [];
  let wantQuery = false;
  let wantRescrape = false;
  for (const op of ops) {
    if (op.action === 'add' && op.title && CATEGORIES.includes(op.category)) {
      await run(env,
        `INSERT INTO items (category,title,notes,due_date,recurrence,recur_day,amount,status,created_by,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?, 'open', ?, ?, ?)`,
        op.category, String(op.title).slice(0, 120), null,
        op.due_date || null, op.recurrence === 'monthly' ? 'monthly' : 'none',
        op.recur_day || null, op.amount || null, who, now, now);
      let d = '';
      if (op.due_date) d = ' — ' + dueLabel(op.due_date, td).replace(/^⚠️ /, '');
      if (op.recurrence === 'monthly') d += ' (monthly)';
      added.push(`${CAT_EMOJI[op.category]} ${op.title}${d}`);
    } else if (op.action === 'complete' && op.id != null) {
      const it = await get(env, 'SELECT * FROM items WHERE id=? AND status=?', op.id, 'open');
      if (!it) continue;
      if (it.recurrence === 'monthly' && it.due_date) {
        const next = addMonth(it.due_date, it.recur_day);
        await run(env, 'UPDATE items SET due_date=?, last_reminded=NULL, updated_at=? WHERE id=?', next, now, it.id);
        completed.push(`${it.title} ✓ (next: ${fmtDate(next)})`);
      } else {
        await run(env, 'UPDATE items SET status=?, updated_at=? WHERE id=?', 'done', now, it.id);
        completed.push(`${it.title} ✓`);
      }
    } else if (op.action === 'query') {
      wantQuery = true;
    } else if (op.action === 'rescrape') {
      wantRescrape = true;
    } else if (op.action === 'set_visit' && op.apt_id != null) {
      const vd = (op.visit_date == null || op.visit_date === '') ? null : String(op.visit_date);
      const arow = await get(env, "SELECT * FROM apartments WHERE id=? AND status='active'", op.apt_id);
      if (arow) {
        await run(env, 'UPDATE apartments SET visit_date=?, updated_at=? WHERE id=?', vd, new Date().toISOString(), op.apt_id);
        visitsSet.push((arow.location || arow.title || ('apto ' + arow.id)) + (vd ? (' → ' + dueLabel(vd, td)) : ' (visita cancelada)'));
      }
    } else if (op.action === 'rule_out' && op.apt_id != null) {
      const arow = await get(env, "SELECT * FROM apartments WHERE id=? AND status='active'", op.apt_id);
      if (arow) {
        const reason = (op.reason && String(op.reason).trim()) ? String(op.reason).trim().slice(0, 120) : null;
        const rnow = new Date().toISOString();
        await run(env, "UPDATE apartments SET status='ruled_out', ruled_out_reason=?, ruled_out_at=?, updated_at=? WHERE id=?", reason, rnow, rnow, op.apt_id);
        ruledOut.push((arow.location || arow.title || ('apto ' + arow.id)) + (reason ? (' — ' + reason) : ''));
      }
    } else if (op.action === 'reactivate' && op.apt_id != null) {
      const arow = await get(env, "SELECT * FROM apartments WHERE id=? AND status='ruled_out'", op.apt_id);
      if (arow) {
        await run(env, "UPDATE apartments SET status='active', ruled_out_reason=NULL, ruled_out_at=NULL, updated_at=? WHERE id=?", new Date().toISOString(), op.apt_id);
        reactivated.push(arow.location || arow.title || ('apto ' + arow.id));
      }
    }
  }

  // build ack
  const lines: string[] = [];
  if (added.length) lines.push('*Logged:*\n' + added.map(a => '• ' + a).join('\n'));
  if (completed.length) lines.push('*Done:*\n' + completed.map(c => '• ' + c).join('\n'));
  if (visitsSet.length) lines.push('*Visita agendada:*\n' + visitsSet.map(v => '• ' + v).join('\n'));
  if (ruledOut.length) lines.push('🚫 *Descartado(s)* (siguen guardados en la app, sección Descartados):\n' + ruledOut.map(v => '• ' + v).join('\n'));
  if (reactivated.length) lines.push('↩️ *De vuelta en la lista:*\n' + reactivated.map(v => '• ' + v).join('\n'));
  if (wantQuery) {
    lines.push(await buildDigestBody(env, td, 'Here is what is pending:'));
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
  if (lines.length) await tgSend(env, lines.join('\n\n'));
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
  const rowHtml = (title: string, rec: string, meta: string, cls: string) =>
    '<div class="row"><span class="title">' + esc(title) + rec + '</span><span class="meta ' + cls + '">' + esc(meta) + '</span></div>';
  const bills = open.filter((i: any) => i.category === 'bills' && i.due_date);
  const dueBills = bills.filter((b: any) => daysBetween(td, b.due_date) <= 1).sort((a: any, b: any) => a.due_date < b.due_date ? -1 : 1);
  let sections = '';
  if (dueBills.length) {
    let rows = '';
    for (const b of dueBills) {
      const n = daysBetween(td, b.due_date);
      const cls = n <= 0 ? 'err' : 'warn';
      const amt = b.amount ? (' · ' + b.amount) : '';
      rows += rowHtml(b.title + amt, '', strip(dueLabel(b.due_date, td)), cls);
    }
    sections += '<div class="card attention"><h2>💵 Bills needing attention<span class="count">' + dueBills.length + '</span></h2>' + rows + '</div>';
  }
  for (const cat of CATEGORIES) {
    const items = open.filter((i: any) => i.category === cat && !(cat === 'bills' && dueBills.some((d: any) => d.id === i.id)));
    if (!items.length) continue;
    let rows = '';
    for (const i of items) {
      let meta = '';
      if (i.due_date) meta = strip(dueLabel(i.due_date, td));
      else if (i.amount) meta = i.amount;
      const rec = i.recurrence === 'monthly' ? '<span class="rec">monthly</span>' : '';
      rows += rowHtml(i.title, rec, meta, '');
    }
    sections += '<div class="card"><h2>' + CAT_EMOJI[cat] + ' ' + CAT_LABEL[cat] + '<span class="count">' + items.length + '</span></h2>' + rows + '</div>';
  }
  if (!sections) sections = '<div class="card empty">Nothing tracked yet — log something in the group. 🎉</div>';
  const updated = new Intl.DateTimeFormat('es-CO', { timeZone: TZ, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date());
  return html(dashboardHtml.replace('{{SECTIONS}}', sections).replace('{{UPDATED}}', updated));
}

async function apartmentsData(env: Env): Promise<Response> {
  const rows = await all(env, "SELECT * FROM apartments WHERE status='active' ORDER BY created_at DESC");
  const ruledOut = await all(env, "SELECT * FROM apartments WHERE status='ruled_out' ORDER BY ruled_out_at DESC, updated_at DESC");
  return json({ apartments: rows, ruledOut, today: today() });
}

async function apartmentsAction(env: Env, req: Request): Promise<Response> {
  const b: any = await req.json().catch(() => ({}));
  const id = Number(b.id);
  if (!id) return json({ ok: false, error: 'missing id' }, 400);
  if (b.action === 'set_visit') {
    const vd = (b.visit_date == null || b.visit_date === '') ? null : String(b.visit_date);
    await run(env, 'UPDATE apartments SET visit_date=?, updated_at=? WHERE id=?', vd, new Date().toISOString(), id);
    return json({ ok: true, row: await get(env, 'SELECT * FROM apartments WHERE id=?', id) });
  }
  if (b.action === 'rule_out') {
    const reason = (b.reason && String(b.reason).trim()) ? String(b.reason).trim().slice(0, 120) : null;
    const now = new Date().toISOString();
    await run(env, "UPDATE apartments SET status='ruled_out', ruled_out_reason=?, ruled_out_at=?, updated_at=? WHERE id=?", reason, now, now, id);
    return json({ ok: true, row: await get(env, 'SELECT * FROM apartments WHERE id=?', id) });
  }
  if (b.action === 'reactivate') {
    await run(env, "UPDATE apartments SET status='active', ruled_out_reason=NULL, ruled_out_at=NULL, updated_at=? WHERE id=?", new Date().toISOString(), id);
    return json({ ok: true, row: await get(env, 'SELECT * FROM apartments WHERE id=?', id) });
  }
  if (b.action === 'rescrape') {
    const res = await rescrapeOne(env, id);
    return json({ ...res, row: await get(env, 'SELECT * FROM apartments WHERE id=?', id) });
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

    if (req.method === 'GET' && path === '/dashboard.html') return dashboardPage(env);
    if (req.method === 'GET' && path === '/apartments.html') return html(apartmentsHtml);
    if (req.method === 'GET' && path === '/apartments-data.json') return apartmentsData(env);
    if (req.method === 'POST' && path === '/apartments-action') return apartmentsAction(env, req);

    return new Response('not found', { status: 404 });
  },

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await sendDigest(env);
  },
} satisfies ExportedHandler<Env>;
