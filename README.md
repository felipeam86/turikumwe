# Turikumwe — Household + Apartment-Hunt Worker

One Cloudflare Worker: a Telegram group is the only input. Plain messages
become tracked household items (Claude parses them into ops), listing URLs
become scraped + extracted apartments, crons post a daily digest and visit
reminders, and two Access-protected web screens (`/dashboard.html`,
`/apartments.html`) mirror the data.

How it's built lives in **`ARCHITECTURE.md`** (routes, data model, crons,
migration discipline). This file is setup only.

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

Migrating an existing database after a schema change: see
`ARCHITECTURE.md` §6 — new columns need a one-off `ALTER TABLE` **before**
deploy; new tables just re-apply `schema.sql`.

### 2. Config

In `wrangler.toml`, set `GROUP_CHAT_ID` to the Telegram group's chat id
(usually negative, e.g. `-100123456789`). Then set the three secrets:

```sh
npx wrangler secret put BOT_TOKEN          # from @BotFather
npx wrangler secret put TG_WEBHOOK_SECRET  # any random string, e.g. `openssl rand -hex 32`
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put MCP_TOKEN          # any random string — bearer token for /mcp
```

For calendar invites, enable Email Routing on the zone and verify both
recipient addresses (they're listed in `allowed_destination_addresses` and
`INVITE_TO` in `wrangler.toml`).

### 3. Deploy

```sh
npx wrangler deploy
```

Cloudflare Access can't cover `*.workers.dev`, so give the Worker a **custom
domain** on a zone you own (Worker → Settings → Domains & Routes → Custom
domain, e.g. `casa.example.com`). Use that hostname below.

### 4. Register the Telegram webhook

```sh
curl "https://api.telegram.org/bot$BOT_TOKEN/setWebhook" \
  -d "url=https://casa.example.com/telegram-webhook" \
  -d "secret_token=$TG_WEBHOOK_SECRET"
```

Telegram sends the secret in the `X-Telegram-Bot-Api-Secret-Token` header;
the Worker rejects anything else. Note: with BotFather privacy mode on
(default), the bot only sees group messages that mention it or replies — run
`/setprivacy` → Disable so it sees every message in the group.

### 5. Cloudflare Access

In Zero Trust → Access → Applications, create three self-hosted applications
on the custom domain:

1. **Webhook bypass** — application domain `casa.example.com`, path
   `telegram-webhook`; one policy with action **Bypass**, include
   **Everyone**. (The webhook is protected only by the secret token.)
2. **MCP bypass** — application domain `casa.example.com`, path `mcp`; one
   policy with action **Bypass**, include **Everyone**. (The endpoint is
   protected only by the `MCP_TOKEN` bearer token.)
3. **Web UI** — application domain `casa.example.com` (all paths); one policy
   with action **Allow**, include **Emails** = your two email addresses;
   login method **One-time PIN**.

Access matches the most specific application first, so the webhook and MCP
paths stay open while everything else requires the PIN login.

The crons are already in `wrangler.toml` and activate on deploy — nothing to
configure.

### 6. Connect an MCP client (optional)

The Worker exposes an MCP server at `https://casa.example.com/mcp`
(read-only SQL `query`, `get_schema`, and `add_apartment_note`),
authenticated with the `MCP_TOKEN` bearer token.

- **Claude Code**:

  ```sh
  claude mcp add --transport http turikumwe https://casa.example.com/mcp \
    --header "Authorization: Bearer $MCP_TOKEN"
  ```

- **Claude API (MCP connector)**: pass the server under `mcp_servers` with
  `authorization_token` set to the token.
- **claude.ai / Claude Desktop custom connectors**: add the URL and put
  `Bearer <token>` in the `Authorization` request header field (request-header
  auth for custom connectors is in beta rollout; until it's enabled on the
  account, use Claude Code or the API connector).

## Install on Android

Open the site in Chrome → menu ⋮ → **Agregar a pantalla principal** (Chrome
may also show an install prompt on its own). The app opens standalone with
its own icon.

Web actions and installability depend on the Cloudflare Access session, so
set a long **Session Duration** (e.g. 1 month) on the Web UI Access
application (Zero Trust → Access → Applications → edit → Session Duration) to
keep the OTP login rare.
