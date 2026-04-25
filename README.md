# Gmail Amazon reschedule monitor

Next.js dashboard that scans multiple Gmail inboxes over IMAP, finds **Amazon Carrier Central** messages whose subjects match the warehouse reschedule pattern, and stores them in PostgreSQL via Prisma.

## Prerequisites

- Node.js 20+ (see Prisma 7 engine notes in the install log if you use an older runtime)
- PostgreSQL instance and a `DATABASE_URL`
- Gmail **App Passwords** for each monitored account (2-Step Verification must be enabled on the Google account)

## Gmail App Passwords

1. Open [Google Account security](https://myaccount.google.com/security).
2. Enable **2-Step Verification** if it is not already on.
3. Open [App passwords](https://myaccount.google.com/apppasswords) (Google may label this “App passwords” under 2-Step Verification).
4. Create an app password for **Mail** (device can be “Other” — e.g. “gmail-monitor”).
5. Copy the 16-character password (no spaces) and put it in `GMAIL_ACCOUNTS_JSON` for that account’s `appPassword` field in `.env.local`.

Repeat for each Gmail address you monitor. Never reuse a screenshot or chat to store these; keep them only in local env files.

## Setup

1. Clone the repo and install dependencies:

   ```bash
   npm install
   ```

2. Copy the environment template and edit secrets locally:

   ```bash
   cp .env.example .env.local
   ```

3. Set `DATABASE_URL` in `.env.local` to your Postgres URL.

4. Set `GMAIL_ACCOUNTS_JSON` to a **JSON array** of objects:

   - `email` — full Gmail address  
   - `region` — label you want on the dashboard (`SAV`, `OAK`, etc.)  
   - `appPassword` — the Gmail app password (not your normal Google password)

   Put the JSON on **one line** in `.env.local`, or escape newlines. Do not commit `.env.local` (it is ignored via `.gitignore`).

5. Apply the database schema:

   ```bash
   npx prisma migrate deploy
   ```

   For local development you can instead run:

   ```bash
   npx prisma migrate dev
   ```

6. Start the app:

   ```bash
   npm run dev
   ```

   Open [http://localhost:3000](http://localhost:3000).

## Scanning

- Click **Scan Now** on the home page, or send:

  ```http
  POST /api/scan-gmail
  ```

  Response JSON includes `scannedAccounts`, `inserted`, `skipped`, and an `accounts` array with per-account `ok`, `inserted`, `skipped`, and `error` if login or IMAP failed for that inbox. Other accounts are still processed.

- The scanner connects to `imap.gmail.com:993` (TLS), opens `INBOX`, and searches with Gmail `X-GM-RAW`: **`newer_than:ceil(N/24)d`** plus **RESCHEDULE** / **Appointment** in the subject, where **N** is `SCAN_LOOKBACK_HOURS` (default **72** hours). After fetch, only messages whose **INTERNALDATE** (received in Gmail) falls within the last **N** hours are kept, then the subject must match the warehouse reschedule regex. One row per inbox + appointment id (latest `INTERNALDATE` wins on upsert). If `X-GM-RAW` fails, it falls back to IMAP `SUBJECT RESCHEDULE` (newest 5000 UIDs if huge).

### Automatic scan every 2 hours (works even if page is closed)

Manual **Scan Now** remains unchanged.

For unattended scans, this repo includes:

- `GET /api/scan-gmail/cron` (protected by bearer secret)
- `vercel.json` cron schedule: `0 */2 * * *`

Setup:

1. In deployment env vars, set either `CRON_SECRET` (recommended on Vercel) or `SCAN_CRON_SECRET`.
2. Deploy. Vercel Cron will call `/api/scan-gmail/cron` every 2 hours.

Security behavior:

- Route accepts `Authorization: Bearer <secret>`.
- It also accepts `?secret=` query param for non-Vercel schedulers if needed.
- Missing or wrong secret returns `401 Unauthorized`.

## WeChat notifications (when new rows are saved)

When a scan saves rows (`inserted > 0`), the server can push a WeChat alert with:

- total saved count
- email account
- warehouse
- appointment ID
- appointment time / received time

Supported channels (enable either one or both):

1. **Enterprise WeCom bot**
   - Set `WECOM_BOT_WEBHOOK_URL`
2. **Personal WeChat via Server酱 Turbo**
   - Set `SERVERCHAN_SENDKEY`

Notes:

- Notification send failures are logged, but do not fail the scan API.
- Both manual scan (`POST /api/scan-gmail`) and scheduled scan (`/api/scan-gmail/cron`) trigger notifications.
- Duplicate push control is enabled by default: same `emailAccount + appointmentId` sends at most once per 30 minutes (`NOTIFY_THROTTLE_MINUTES`).

## Phase 2 UI enhancements

- Home page now shows an **Alerts** unread badge (red dot count style).
- Added a **Recent alerts** panel listing latest alert candidates from saved rows.
- **Mark all read** is stored in browser local storage (per browser/device).

## Data retention

- After each scan (manual or cron), old rows are automatically cleaned.
- Default retention window is **14 days** (`receivedAt` older than this is deleted).
- Override with `DATA_RETENTION_DAYS` (minimum 1 day).

## API: list stored rows

```http
GET /api/reschedule-emails?region=OAK&warehouse=MCO2&emailAccount=user@gmail.com&appointmentId=7119433968&limit=200
```

Query parameters are optional filters. Results are ordered by `receivedAt` descending.
`limit` is optional (default `200`, max `1000`).

## Security notes

- App passwords exist only in `GMAIL_ACCOUNTS_JSON` on the server; they are never sent to the browser.
- Do not commit `.env` or `.env.local`.

## Subject pattern

Subjects must match:

```text
WAREHOUSE RESCHEDULE: Appointment #APPOINTMENT_ID, Appointment Time: DATE_TIME
```

Example:

```text
MCO2 RESCHEDULE: Appointment #7119433968, Appointment Time: Thu 04/23/2026 19:00 EDT
```

Parsed fields: `warehouse` = `MCO2`, `appointmentId` = `7119433968`, `appointmentTimeText` = the remainder after “Appointment Time:”.
