# sms-mail-receiver

Automated **email activation receiver** powered by [Hero-SMS](https://hero-sms.com/). Runs on **Render**, delivers mail via **webhook + 2s polling**, alerts you on **Telegram**, and includes a **web dashboard**.

Built for **zero delay tolerance**: the service never waits for Render to sleep, polls waiting orders every 2 seconds, and accepts Hero-SMS webhooks for instant delivery.

## Architecture

```
Hero-SMS ──webhook──► POST /webhook/hero-sms ──► SQLite ──► Telegram alert
    │                                              ▲
    └── REST API ◄── poll worker (every 2s) ───────┘
    
Render keep-alive ──► GET /api/health (every 10 min)
Web dashboard ──────► GET /api/orders (auto-refresh 2s)
```

## Features

- **Gems wallet** — users top up gems and spend on email orders
- **Dynamic MYR rate** — at USD/MYR = 4, 1 MYR = 10,000 gems; adjusts with live USD/MYR
- **Payment methods** — Billplz (FPX/card/TnG/GrabPay), Telegram Stars, manual TnG & bank transfer
- Order disposable emails via Hero-SMS API
- **Webhook endpoint** for instant mail push (configure in Hero-SMS dashboard)
- **Fast polling fallback** every 2s for any order still in `WAIT`
- **Render keep-alive** self-pings every 10 minutes (before 15 min sleep on free tier)
- **Telegram bot** — balance, top-up, order, list, cancel, instant mail alerts
- **Web dashboard** — gems wallet, top-up, orders, live refresh

## Gems & payments

### Exchange formula

```
gemsPerMyr = BASE_GEMS_PER_MYR × (BASE_USD_MYR / current USD/MYR)
```

Default: `BASE_USD_MYR=4`, `BASE_GEMS_PER_MYR=10000` → **1 MYR = 10,000 gems** when USD/MYR is 4.

Example at USD/MYR 4.12 → ~9,715 gems per MYR.

### Payment methods

| Method | Env vars | Settlement |
|--------|----------|------------|
| **Billplz** | `BILLPLZ_API_KEY`, `BILLPLZ_COLLECTION_ID` | FPX, card, TnG, GrabPay → your bank |
| **Telegram Stars** | `TELEGRAM_PAYMENT_PROVIDER_TOKEN` | Telegram payout → bank |
| **Manual TnG** | `MANUAL_TNG_PHONE` | Direct to your TnG |
| **Manual bank** | `MANUAL_BANK_*` | Direct to your bank |

Manual payments need admin approval: `/approve` or `/approve <id>` (set `ADMIN_TELEGRAM_IDS`).

### Telegram wallet commands

| Command | Description |
|---------|-------------|
| `/balance` | Gems balance + live exchange rate |
| `/topup` | Buy gems (package + payment method) |
| `/approve` | Admin: list/approve manual payments |

## Quick start (local)

1. Copy env file and fill in keys:

```bash
cd telegram-web-app
npm install
copy .env.example .env
```

2. Required in `.env`:

```env
HERO_SMS_API_KEY=your_key
TELEGRAM_BOT_TOKEN=your_bot_token
DEFAULT_EMAIL_SITE=telegram.com
DEFAULT_EMAIL_DOMAIN=gmail.com
```

3. Run:

```bash
npm run dev
```

4. Open http://localhost:3000 and message your Telegram bot.

## Deploy on Render

1. Push to GitHub.
2. **New → Blueprint** → connect repo (uses `render.yaml`).
3. Set env vars after first deploy:

| Variable | Value |
|----------|--------|
| `HERO_SMS_API_KEY` | From hero-sms.com |
| `TELEGRAM_BOT_TOKEN` | From @BotFather |
| `WEBAPP_URL` | `https://your-app.onrender.com` |
| `TELEGRAM_BOT_USERNAME` | Bot username without `@` |
| `WEBHOOK_SECRET` | Optional shared secret |

4. Redeploy after setting `WEBAPP_URL`.

## Hero-SMS webhook setup

1. Deploy the app and set `WEBAPP_URL`.
2. In Hero-SMS dashboard, set webhook URL to:

```
https://your-app.onrender.com/webhook/hero-sms
```

3. If you set `WEBHOOK_SECRET`, send header `X-Webhook-Secret: your_secret` or `?secret=your_secret`.

Run `/webhook` in Telegram to get the exact URL.

## Render sleep prevention

Free Render services sleep after ~15 minutes of no HTTP traffic.

This app handles it two ways:

1. **Built-in keep-alive** — pings `/api/health` every 10 minutes (`KEEPALIVE_INTERVAL_MS=600000`)
2. **External monitor (recommended backup)** — add [cron-job.org](https://cron-job.org) or UptimeRobot to hit:

```
https://your-app.onrender.com/api/health
```

every 5–10 minutes.

For **production with zero cold-start risk**, use Render **paid** plan (always on) or an external ping every 5 min.

## Telegram commands

| Command | Description |
|---------|-------------|
| `/order telegram.com gmail.com` | Buy email activation |
| `/list` | Active orders |
| `/mail 1` | Refresh order #1 from Hero-SMS |
| `/domains` | Available email domains |
| `/cancel 1` | Cancel order #1 |
| `/web` | Personal web dashboard link |
| `/webhook` | Webhook URL for Hero-SMS |
| `/balance` | Gems balance & rate |
| `/topup` | Buy gems |
| `/help` | Command list |

## Web dashboard

- Order emails with site + domain
- Auto-refreshes every 2 seconds
- Shows codes/messages as soon as they arrive
- Use `/web` in Telegram for a synced token link

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `POLL_INTERVAL_MS` | `2000` | Poll waiting orders (ms) |
| `KEEPALIVE_INTERVAL_MS` | `600000` | Self-ping interval (ms) |
| `DEFAULT_EMAIL_SITE` | `telegram.com` | Default site for orders |
| `DEFAULT_EMAIL_DOMAIN` | `gmail.com` | Default domain for orders |
| `HERO_SMS_BASE_URL` | `https://hero-sms.com/api/v1` | API base URL |
| `BASE_USD_MYR` | `4` | Reference USD/MYR for gem formula |
| `BASE_GEMS_PER_MYR` | `10000` | Gems per MYR at reference rate |
| `BILLPLZ_API_KEY` | — | Billplz API key |
| `MANUAL_TNG_PHONE` | — | Your TnG number for manual top-up |
| `ADMIN_TELEGRAM_IDS` | — | Comma-separated admin Telegram IDs |

## API endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/health` | No | Health + keep-alive status |
| POST | `/webhook/hero-sms` | Optional secret | Hero-SMS webhook |
| GET | `/api/orders` | Bearer token | List orders |
| POST | `/api/orders` | Bearer token | Order email (deducts gems) |
| DELETE | `/api/orders/:id` | Bearer token | Cancel order (refund gems if no mail) |
| GET | `/api/wallet` | Bearer token | Gems balance, packages, methods |
| GET | `/api/exchange` | Bearer token | Live USD/MYR & gems rate |
| POST | `/api/topup` | Bearer token | Start top-up (Billplz/manual) |
| POST | `/webhook/billplz` | Billplz callback | Credit gems on payment |

## Notes

- SQLite data persists on Render via the `/var/data` disk in `render.yaml`.
- Webhook is the fastest path; polling is the safety net.
- If Hero-SMS sends a payload shape not yet handled, check logs and open an issue — `parseWebhookPayload` accepts multiple field names (`id`, `emailId`, `activationId`, `value`, `code`, etc.).
