CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  notes TEXT,
  due_date TEXT,
  recurrence TEXT NOT NULL DEFAULT 'none',
  recur_day INTEGER,
  amount TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_reminded TEXT
);

CREATE TABLE IF NOT EXISTS apartments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT,
  deal_type TEXT,
  title TEXT,
  price INTEGER,
  admin_fee INTEGER,
  bedrooms INTEGER,
  bathrooms INTEGER,
  area_m2 REAL,
  price_per_m2 INTEGER,
  parking INTEGER,
  stratum INTEGER,
  location TEXT,
  year_built INTEGER,
  amenities TEXT,
  source_site TEXT,
  raw_note TEXT,
  scrape_status TEXT,
  image_url TEXT,
  notes TEXT,
  address TEXT,
  agent_name TEXT,
  agent_phone TEXT,
  tag TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ruled_out_reason TEXT,
  ruled_out_at TEXT,
  -- previous price + when it changed, written only when a rescrape sees a different price
  -- (manual edits are corrections, not market signals); one prior value is enough
  prev_price INTEGER,
  price_changed_at TEXT,
  -- cached geocode (Nominatim/OSM) for the map pins. geo_address remembers the exact address
  -- string the coords came from: address edited => mismatch => re-geocode; lookup found nothing
  -- => geo_address set with NULL coords, so the same bad address isn't retried on every load
  geo_lat REAL,
  geo_lng REAL,
  geo_address TEXT
);

-- photos taken during visits, sent to the Telegram group. Only permanent Telegram
-- file_ids are stored (full size + a mid-size rendition for the web thumb strip);
-- the short-lived file_path is resolved on demand.
-- one structured 👍/👎 per person per apartment. voter is canonical ('felipe' | 'lucia' —
-- unknown identities fall back to their normalized name), vote is 'up' | 'down'; clearing
-- a verdict deletes the row.
CREATE TABLE IF NOT EXISTS apartment_votes (
  apartment_id INTEGER NOT NULL,
  voter TEXT NOT NULL,
  vote TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (apartment_id, voter)
);

CREATE TABLE IF NOT EXISTS apartment_photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  apartment_id INTEGER NOT NULL,
  tg_file_id TEXT NOT NULL,
  tg_thumb_file_id TEXT,
  caption TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);

-- one row per visit (first visit + follow-ups). status is only 'scheduled' | 'cancelled':
-- a non-cancelled visit whose datetime has passed reads as "hecha" (date-only visits count
-- through the end of their day). visit_date is Bogota wall-clock TEXT like everywhere else;
-- reminder_sent stores the covered datetime (not a boolean) so a reschedule re-arms it.
-- note holds the outcome/impressions of THIS visit as stamped lines ('YYYY-MM-DD [Autor]: text').
-- Legacy installs migrated the old apartments.visit_date/visit_reminder_sent columns into
-- these rows (ARCHITECTURE.md §6); the dead columns may linger there, unread.
CREATE TABLE IF NOT EXISTS apartment_visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  apartment_id INTEGER NOT NULL,
  visit_date TEXT NOT NULL,
  who TEXT,
  status TEXT NOT NULL DEFAULT 'scheduled',
  note TEXT,
  reminder_sent TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- due-diligence documents requested from realtors. A row exists once requested/received —
-- there is no auto-seeded checklist; doc_type is a DOC_TYPES slug (index.ts) or 'otro' with a
-- free label. status: 'pending' (requested) | 'received' | 'na'. Files arrive via Telegram
-- document messages and are stored like photos: permanent tg_file_id only, no bytes.
CREATE TABLE IF NOT EXISTS apartment_docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  apartment_id INTEGER NOT NULL,
  doc_type TEXT NOT NULL,
  label TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  tg_file_id TEXT,
  file_name TEXT,
  mime_type TEXT,
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
