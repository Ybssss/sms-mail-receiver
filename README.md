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

- Order disposable emails via Hero-SMS API
- **Webhook endpoint** for instant mail push (configure in Hero-SMS dashboard)
- **Fast polling fallback** every 2s for any order still in `WAIT`
- **Render keep-alive** self-pings every 10 minutes (before 15 min sleep on free tier)
- **Telegram bot** — order, list, cancel, instant mail alerts
- **Web dashboard** — same orders, live refresh

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

## API endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/health` | No | Health + keep-alive status |
| POST | `/webhook/hero-sms` | Optional secret | Hero-SMS webhook |
| GET | `/api/orders` | Bearer token | List orders |
| POST | `/api/orders` | Bearer token | Order email |
| DELETE | `/api/orders/:id` | Bearer token | Cancel order |

## Notes

- SQLite data persists on Render via the `/var/data` disk in `render.yaml`.
- Webhook is the fastest path; polling is the safety net.
- If Hero-SMS sends a payload shape not yet handled, check logs and open an issue — `parseWebhookPayload` accepts multiple field names (`id`, `emailId`, `activationId`, `value`, `code`, etc.).
