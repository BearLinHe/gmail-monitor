# Gmail Amazon reschedule monitor

Next.js dashboard that scans authorized Gmail inboxes for **Amazon Carrier Central** reschedule messages and stores matching appointment details in PostgreSQL. Connect Gmail and Google Workspace inboxes through the Gmail API. Existing IMAP accounts can continue scanning while you migrate them.

## Prerequisites

- Node.js 20+ (see Prisma 7 engine notes in the install log if you use an older runtime)
- PostgreSQL instance and a `DATABASE_URL`
- Google Cloud Web OAuth client with Gmail API enabled for adding or reconnecting inboxes

## Setup

1. Clone the repo and install dependencies:

   ```bash
   npm install
   ```

2. Copy the environment template and edit secrets locally:

   ```bash
   cp .env.example .env.local
   ```

3. Set `DATABASE_URL` in `.env.local` to your Postgres URL. Set `GMAIL_MONITOR_ADMIN_PASSWORD` to a randomly generated console password (`openssl rand -hex 32`). The dashboard data and manual scan endpoints require a signed-in operator. This console is intended for trusted staff who may see all monitored inboxes.

4. Apply the database schema:

   ```bash
   npx prisma migrate deploy
   ```

   For local development you can instead run:

   ```bash
   npx prisma migrate dev
   ```

5. Start the app:

   ```bash
   npm run dev
   ```

   Open [http://localhost:3000](http://localhost:3000).

## Add and reconnect Gmail inboxes

1. In Google Cloud, enable Gmail API and configure the OAuth consent screen. Use **External** to support personal Gmail and Workspace inboxes outside your Google Cloud organization. While the OAuth app is in Testing, add each mailbox as a Google test user. Gmail refresh tokens in External Testing expire after seven days. To let operators add new inboxes without managing the test-user list, publish the OAuth app and meet Google's applicable restricted-scope verification requirements. See [Google OAuth app states](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview) and [restricted-scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification).
2. Create a **Web application** OAuth client. Add `http://localhost:3000/api/gmail-connections/callback` for local testing or `https://your-app.example.com/api/gmail-connections/callback` for deployment as an authorized redirect URI. The OAuth callback must use the same origin that operators open.
3. Set `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and the matching `GOOGLE_OAUTH_REDIRECT_URI` in the server environment. Generate `GMAIL_OAUTH_TOKEN_KEY` with `openssl rand -base64 32`. Keep that key stable across deployments to allow the app to decrypt existing authorizations. Use a separate database and OAuth configuration for isolated testing.
4. Open `/gmail-connections`, sign in with the console password, then enter the email address and region and continue to Google. Complete sign-in and consent in Google's page. Once the address and offline access have been verified, the app automatically includes it in the next manual or scheduled scan. Refresh the list to see the latest successful scan time. If Google revokes access, use **Reconnect** on that account.

The app requests Gmail read-only access so it can search for reschedule subjects in Gmail. Actual message requests fetch the needed headers and received timestamp. Refresh tokens are encrypted in PostgreSQL and Gmail passwords are entered only on Google's page.

### Migrate existing mailboxes

Keep existing server-side `GMAIL_ACCOUNTS_JSON` entries during rollout. Each legacy entry has an `email`, `region`, and Gmail `appPassword`. Open the account's **Connect with Google** action. The app replaces IMAP for that address once OAuth has been verified. Briefly losing OAuth access will require reconnecting that mailbox, and other mailboxes continue scanning. After a successful scheduled scan for a migrated mailbox, remove the matching legacy entry. Remove `GMAIL_ACCOUNTS_JSON` once every mailbox has moved to OAuth.

To validate the production path before removing legacy entries, connect a mailbox, run the **Gmail Scan Cron** GitHub Actions workflow, and confirm **Last successful scan** on the mailbox. On an isolated test mailbox, revoke the app's access in Google, run the workflow again, confirm **Needs reconnection**, then reconnect and verify a new successful scheduled scan.

## Scanning

- Click **Scan Now** on the home page, or send:

  ```http
  POST /api/scan-gmail
  ```

  The manual endpoint requires a valid console session. Response JSON includes `scannedAccounts`, `inserted`, `skipped`, and an `accounts` array with individual mailbox results. One mailbox's authorization failure does not prevent scanning the others.

- Both Gmail API and legacy IMAP scans look for **RESCHEDULE** and **Appointment** in the subject and use `SCAN_LOOKBACK_HOURS` (default **72** hours). The timestamp must fall in the lookback window and the subject must match the pattern below. The newest message wins for each mailbox and appointment ID. Legacy IMAP uses All Mail when available and falls back to INBOX.

### Automatic scan every 2 hours (works even if page is closed)

The GitHub Actions workflow in `.github/workflows/scan-cron.yml` calls the bearer-protected `GET /api/scan-gmail/cron` endpoint every two hours. Every connected mailbox is picked up automatically. Keep the scheduled endpoint accessible to the workflow.

Setup:

1. In deployment env vars, set either `CRON_SECRET` (recommended on Vercel) or `SCAN_CRON_SECRET`.
2. Deploy.
3. In GitHub, set the repository secrets `APP_BASE_URL` (the deployed monitor URL) and `CRON_SECRET` (the same value as the app's scheduler secret). Enable **Gmail Scan Cron**.

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
