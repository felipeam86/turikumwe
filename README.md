# Household + Apartment-Hunt Worker

One Cloudflare Worker: a Telegram group is the only input. Plain messages become tracked household items (Claude parses them into ops), listing URLs become scraped + extracted apartments, a daily digest posts every morning, and two Access-protected web screens (`/dashboard.html`, `/apartments.html`) mirror the data.

## Setup

### 1. Install & create the database

Wrangler requires Node.js ≥ 22 (`nvm use 22`).

```sh
npm install
npx wrangler d1 create household
```

Paste the returned `database_id` into `wrangler.toml`, then apply the schema:

```sh
npx wrangler d1 execute household --remote --file schema.sql
```

(For local dev: same command with `--local`.)

**Migrating a database created before the apartment photo/notes columns:**

Run this **before** `wrangler deploy` — `schema.sql` uses `CREATE TABLE IF NOT EXISTS`, so re-applying it won't add the columns, and the new Worker's apartment `INSERT`/`UPDATE`s reference `image_url`/`notes` and will fail until they exist:

```sh
npx wrangler d1 execute household --remote --command "ALTER TABLE apartments ADD COLUMN image_url TEXT; ALTER TABLE apartments ADD COLUMN notes TEXT"
```

**Migrating a database created before the apartment address/agent/tag columns:**

Same reasoning — run **before** `wrangler deploy`, or the `set_fields` action will fail:

```sh
npx wrangler d1 execute household --remote --command "ALTER TABLE apartments ADD COLUMN address TEXT; ALTER TABLE apartments ADD COLUMN agent_name TEXT; ALTER TABLE apartments ADD COLUMN agent_phone TEXT; ALTER TABLE apartments ADD COLUMN tag TEXT"
```

**Migrating a database created before the visit-reminder column:**

Same reasoning — run **before** `wrangler deploy`, or the hourly visit-reminder cron will fail:

```sh
npx wrangler d1 execute household --remote --command "ALTER TABLE apartments ADD COLUMN visit_reminder_sent TEXT"
```

**Migrating a database created before visit photos:** `apartment_photos` is a **new table**, so no `ALTER` is needed — just re-apply the schema file (its `CREATE TABLE IF NOT EXISTS` leaves existing tables alone), before deploy:

```sh
npx wrangler d1 execute household --remote --file schema.sql
```

**Migrating a database created before per-person verdicts:** `apartment_votes` is also a **new table** — same as above, re-apply the schema file before deploy:

```sh
npx wrangler d1 execute household --remote --file schema.sql
```

### 2. Config

In `wrangler.toml`, set `GROUP_CHAT_ID` to the Telegram group's chat id (usually negative, e.g. `-100123456789`). Then set the three secrets:

```sh
npx wrangler secret put BOT_TOKEN          # from @BotFather
npx wrangler secret put TG_WEBHOOK_SECRET  # any random string, e.g. `openssl rand -hex 32`
npx wrangler secret put ANTHROPIC_API_KEY
```

### 3. Deploy

```sh
npx wrangler deploy
```

Cloudflare Access can't cover `*.workers.dev`, so give the Worker a **custom domain** on a zone you own (Worker → Settings → Domains & Routes → Custom domain, e.g. `casa.example.com`). Use that hostname below.

### 4. Register the Telegram webhook

```sh
curl "https://api.telegram.org/bot$BOT_TOKEN/setWebhook" \
  -d "url=https://casa.example.com/telegram-webhook" \
  -d "secret_token=$TG_WEBHOOK_SECRET"
```

Telegram sends the secret in the `X-Telegram-Bot-Api-Secret-Token` header; the Worker rejects anything else. Note: with BotFather privacy mode on (default), the bot only sees group messages that mention it or replies — run `/setprivacy` → Disable so it sees every message in the group.

### 5. Cloudflare Access

In Zero Trust → Access → Applications, create two self-hosted applications on the custom domain:

1. **Webhook bypass** — application domain `casa.example.com`, path `telegram-webhook`; one policy with action **Bypass**, include **Everyone**. (The webhook is protected only by the secret token.)
2. **Web UI** — application domain `casa.example.com` (all paths); one policy with action **Allow**, include **Emails** = your two email addresses; login method **One-time PIN**.

Access matches the most specific application first, so the webhook stays open while everything else requires the PIN login.

The cron (07:30 America/Bogota = `30 12 * * *` UTC) is already in `wrangler.toml` and posts the digest on deploy — nothing to configure.

## Endpoints

| Route | Auth | What |
|---|---|---|
| `POST /telegram-webhook` | secret token header | Telegram updates: item ops, apartment URLs, "what's pending?" |
| `GET /` | Access | Home screen: pick Household or Apartamentos |
| `GET /dashboard.html` | Access | Household overview, tap ✓ to complete items |
| `POST /items-action` | Access | `complete` an item (monthly items roll forward); echoes to the Telegram group |
| `GET /apartments.html` | Access | Apartment comparison (mobile-first cards) |
| `GET /apartments-data.json` | Access | Data for the apartments screen |
| `GET /apt-photo/<id>` | Access | A visit photo, streamed from Telegram by its stored `file_id` (`?s=t` = mid-size thumb) |
| `POST /apartments-action` | Access | `set_visit` / `rescrape` / `rule_out` / `reactivate` / `apt_note` / `set_fields` (address, agent, phone, tag); most echo to the Telegram group |
| `GET /manifest.json`, `GET /icon.png` | Access | PWA manifest + icon (icons inlined as data URIs — Chrome fetches manifest icons without the Access cookie) |

## Install on Android

Open the site in Chrome → menu ⋮ → **Agregar a pantalla principal** (Chrome may also show an install prompt on its own). The app opens standalone with its own icon.

Web actions and installability depend on the Cloudflare Access session, so set a long **Session Duration** (e.g. 1 month) on the Web UI Access application (Zero Trust → Access → Applications → edit → Session Duration) to keep the OTP login rare.
