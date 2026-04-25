import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

const SUBJECT_RESCHEDULE_REGEX =
  /^([A-Z0-9]+)\s+RESCHEDULE:\s+Appointment\s+#(\d+),\s+Appointment\s+Time:\s+(.+)$/;

/**
 * Only load RESCHEDULE mail received within this many hours (now − N hours). Keeps scans fast.
 * Set `SCAN_LOOKBACK_HOURS` in `.env.local` (default **72**). Capped at 336 (14 days).
 */
function getLookbackHours(): number {
  const raw = process.env.SCAN_LOOKBACK_HOURS?.trim();
  if (!raw) return 72;
  const n = Math.floor(Number(raw));
  if (!Number.isFinite(n) || n < 1) return 72;
  return Math.min(n, 336);
}

/** Gmail `newer_than:Xd` uses X = ceil(hours / 24), minimum 1 day. */
function gmailNewerThanDays(): number {
  return Math.max(1, Math.ceil(getLookbackHours() / 24));
}

/** Compare INTERNALDATE to this instant (UTC ms) — avoids `setHours` local-time skew. */
function lookbackCutoffMs(): number {
  return Date.now() - getLookbackHours() * 60 * 60 * 1000;
}

export type GmailAccountConfig = {
  email: string;
  region: string;
  appPassword: string;
};

export type AccountScanResult = {
  email: string;
  ok: boolean;
  inserted: number;
  skipped: number;
  error?: string;
  /** First Prisma / DB error when writes fail (so the UI need not rely on server logs). */
  dbError?: string;
  /** Human hint when login OK but nothing saved (or search empty). */
  note?: string;
  /** Gmail search UID count → fetched headers → after INTERNALDATE + regex (debug saved=0). */
  stats?: {
    searchUids: number;
    fetchedHeaders: number;
    afterLookbackAndRegex: number;
    /** Which Gmail folder was searched (`[Gmail]/All Mail` includes archived). */
    mailbox?: string;
    /** Rows that threw on create/update (see `dbError`). */
    dbFailures?: number;
    /** Full-body fetch: envelope subject no longer matched the RESCHEDULE regex. */
    subjectMissAfterBodyFetch?: number;
    /** Second IMAP fetch (with body): how many rows returned vs header-stage candidates. */
    secondPullExpected?: number;
    secondPullReturned?: number;
  };
  /** Samples for notifications when rows are newly saved (create/update). */
  highlights?: Array<{
    emailAccount: string;
    warehouse: string;
    appointmentId: string;
    appointmentTimeText: string;
    receivedAt: string;
    action: "created" | "updated";
  }>;
};

export type ScanGmailResult = {
  success: boolean;
  scannedAccounts: number;
  inserted: number;
  skipped: number;
  accounts: AccountScanResult[];
  highlights: Array<{
    emailAccount: string;
    warehouse: string;
    appointmentId: string;
    appointmentTimeText: string;
    receivedAt: string;
    action: "created" | "updated";
  }>;
};

function formatPrismaError(e: unknown): string {
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = e.meta && Object.keys(e.meta).length ? ` ${JSON.stringify(e.meta)}` : "";
    return `${e.code}: ${e.message}${meta}`.slice(0, 800);
  }
  if (e instanceof Prisma.PrismaClientValidationError) {
    return e.message.slice(0, 800);
  }
  if (e instanceof Error) {
    return e.message.slice(0, 800);
  }
  return String(e).slice(0, 800);
}

function logScanner(level: "info" | "warn" | "error", message: string, meta?: Record<string, unknown>) {
  const payload = { message, ...meta };
  if (level === "error") {
    console.error("[gmail-scanner]", payload);
  } else if (level === "warn") {
    console.warn("[gmail-scanner]", payload);
  } else {
    console.info("[gmail-scanner]", payload);
  }
}

export type ParseGmailAccountsResult = {
  accounts: GmailAccountConfig[];
  /** Set when zero accounts are usable — safe to show in API responses (no secrets). */
  error?: string;
};

/** Strips BOM and optional outer quotes from .env line values. */
function normalizeGmailAccountsJsonEnv(raw: string): string {
  let v = raw.replace(/^\uFEFF/, "").trim();
  if (v.length >= 2) {
    const a = v[0];
    const b = v[v.length - 1];
    if ((a === "'" && b === "'") || (a === '"' && b === '"')) {
      v = v.slice(1, -1).trim();
    }
  }
  return v;
}

export function parseGmailAccountsFromEnvDetailed(): ParseGmailAccountsResult {
  const raw = process.env.GMAIL_ACCOUNTS_JSON;
  if (!raw?.trim()) {
    logScanner("error", "GMAIL_ACCOUNTS_JSON is missing or empty");
    return {
      accounts: [],
      error:
        "GMAIL_ACCOUNTS_JSON is not set. Add it to .env.local (see .env.example): a one-line JSON array of { email, region, appPassword }.",
    };
  }

  const normalized = normalizeGmailAccountsJsonEnv(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(normalized);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logScanner("error", "Failed to parse GMAIL_ACCOUNTS_JSON", { error: msg });
    return {
      accounts: [],
      error: `GMAIL_ACCOUNTS_JSON is not valid JSON (${msg}). Use a single-line array or wrap the whole value in single quotes in .env.local.`,
    };
  }

  if (!Array.isArray(parsed)) {
    logScanner("error", "GMAIL_ACCOUNTS_JSON must be a JSON array");
    return {
      accounts: [],
      error: "GMAIL_ACCOUNTS_JSON must be a JSON array, e.g. [{\"email\":\"...\",\"region\":\"...\",\"appPassword\":\"...\"}].",
    };
  }

  const accounts: GmailAccountConfig[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const email = typeof row.email === "string" ? row.email.trim() : "";
    const region = typeof row.region === "string" ? row.region.trim() : "";
    const appPassword =
      typeof row.appPassword === "string" ? row.appPassword.trim() : "";
    if (!email || !region || !appPassword) {
      logScanner("warn", "Skipping invalid account entry (missing email, region, or appPassword)");
      continue;
    }
    accounts.push({ email, region, appPassword });
  }

  if (accounts.length === 0) {
    return {
      accounts: [],
      error:
        "No valid account objects in GMAIL_ACCOUNTS_JSON. Each entry must be an object with string fields: email, region, appPassword (snake_case keys are not accepted).",
    };
  }

  return { accounts };
}

export function parseGmailAccountsFromEnv(): GmailAccountConfig[] {
  return parseGmailAccountsFromEnvDetailed().accounts;
}

function normalizeMessageId(messageId: string | undefined, email: string, uid: number): string {
  if (messageId?.trim()) {
    return messageId.trim().replace(/^<|>$/g, "");
  }
  return `${email}::uid:${uid}`;
}

/** Gmail IMAP INTERNALDATE — when the message was delivered to the mailbox (matches Gmail list time). */
function internalDateAsDate(internalDate: Date | string | undefined): Date {
  if (internalDate instanceof Date) {
    return internalDate;
  }
  if (typeof internalDate === "string") {
    const d = new Date(internalDate);
    return Number.isFinite(d.getTime()) ? d : new Date();
  }
  return new Date();
}

/** ImapFlow often throws `Error` with message only `Command failed`; server text is on `responseText`. */
function imapErrorDetails(err: unknown): string {
  if (err == null) {
    return "Unknown error";
  }
  if (typeof err !== "object") {
    return String(err);
  }
  const o = err as Record<string, unknown>;
  const parts: string[] = [];
  if (typeof o.responseStatus === "string" && o.responseStatus) {
    parts.push(o.responseStatus);
  }
  if (typeof o.responseText === "string" && o.responseText.trim()) {
    parts.push(o.responseText.trim());
  }
  if (typeof o.code === "string" && o.code && o.code !== "undefined") {
    parts.push(`code=${o.code}`);
  }
  if (parts.length) {
    const joined = parts.join(": ");
    if (/AUTHENTICATIONFAILED|Invalid credentials|authentication failed/i.test(joined)) {
      return `${joined} — use a 16-character Gmail App Password (no spaces), IMAP enabled in Gmail settings.`;
    }
    return joined;
  }
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return String(err);
}

/**
 * Gmail + imapflow: avoid IMAP `SINCE` + `SUBJECT` (YOUNGER issues). Use X-GM-RAW with
 * `newer_than:Xd` (aligned to {@link getLookbackHours}) plus subject keywords; tighten with
 * INTERNALDATE in the candidate filter.
 */
async function searchRescheduleCandidateUids(
  client: ImapFlow,
  email: string,
): Promise<number[] | false> {
  const days = gmailNewerThanDays();
  const gmQuery = `newer_than:${days}d subject:RESCHEDULE subject:Appointment`;
  try {
    return await client.search({ gmailraw: gmQuery });
  } catch (e) {
    logScanner("warn", "X-GM-RAW search failed, falling back to SUBJECT-only IMAP search", {
      email,
      detail: imapErrorDetails(e),
    });
    const uids = await client.search({ subject: "RESCHEDULE" });
    if (Array.isArray(uids) && uids.length > 5000) {
      logScanner("warn", "Large SUBJECT result set; scanning most recent 5000 UIDs only", {
        email,
        total: uids.length,
      });
      return uids.slice(-5000);
    }
    return uids;
  }
}

async function scanAccount(account: GmailAccountConfig): Promise<AccountScanResult> {
  const result: AccountScanResult = {
    email: account.email,
    ok: true,
    inserted: 0,
    skipped: 0,
    highlights: [],
  };

  const client = new ImapFlow({
    host: "imap.gmail.com",
    port: 993,
    secure: true,
    auth: {
      user: account.email,
      pass: account.appPassword,
    },
    logger: false,
  });

  if (account.appPassword.replace(/\s/g, "").length !== 16) {
    logScanner("warn", "App password is not 16 characters (after removing spaces); Gmail may reject login", {
      email: account.email,
      length: account.appPassword.replace(/\s/g, "").length,
    });
  }

  try {
    await client.connect();

    let openedMailbox = "INBOX";
    try {
      await client.mailboxOpen("[Gmail]/All Mail");
      openedMailbox = "[Gmail]/All Mail";
    } catch (openErr) {
      logScanner("warn", "Could not open [Gmail]/All Mail, using INBOX only", {
        email: account.email,
        detail: openErr instanceof Error ? openErr.message : String(openErr),
      });
      await client.mailboxOpen("INBOX");
    }

    logScanner("info", "Scan lookback window", {
      email: account.email,
      lookbackHours: getLookbackHours(),
      gmailNewerThanDays: gmailNewerThanDays(),
      mailbox: openedMailbox,
    });

    const uids = await searchRescheduleCandidateUids(client, account.email);

    if (!uids || uids.length === 0) {
      logScanner("info", "No candidate messages for account", { email: account.email });
      result.stats = {
        searchUids: 0,
        fetchedHeaders: 0,
        afterLookbackAndRegex: 0,
        mailbox: openedMailbox,
      };
      result.note = `在「${openedMailbox}」约 ${gmailNewerThanDays()} 天（Gmail newer_than）内未命中「RESCHEDULE + Appointment」。可调大 SCAN_LOOKBACK_HOURS（当前 ${getLookbackHours()}h）；若信已「归档」仅扫 INBOX 会漏信，本逻辑已优先扫「所有邮件」。`;
      return result;
    }

    const sinceMs = lookbackCutoffMs();

    const summaries = await client.fetchAll(uids, {
      uid: true,
      envelope: true,
      internalDate: true,
    });

    const candidates = summaries.filter((msg) => {
      const id = msg.internalDate;
      const t =
        id instanceof Date
          ? id.getTime()
          : typeof id === "string"
            ? new Date(id).getTime()
            : NaN;
      if (!Number.isFinite(t) || t < sinceMs) {
        return false;
      }
      const subject = msg.envelope?.subject ?? "";
      return (
        /RESCHEDULE/i.test(subject) &&
        /Appointment/i.test(subject) &&
        SUBJECT_RESCHEDULE_REGEX.test(subject.trim())
      );
    });

    if (candidates.length === 0) {
      result.stats = {
        searchUids: uids.length,
        fetchedHeaders: summaries.length,
        afterLookbackAndRegex: 0,
        mailbox: openedMailbox,
      };
      result.note = `「${openedMailbox}」命中 ${uids.length} 个 UID、拉取 ${summaries.length} 封头信息，但在最近 ${getLookbackHours()}h（按 INTERNALDATE 与 UTC 时间窗比较）、且主题符合 RESCHEDULE 正则的为 0。可调大 SCAN_LOOKBACK_HOURS；仅「Confirmed」主题不会被匹配。`;
      return result;
    }

    result.stats = {
      searchUids: uids.length,
      fetchedHeaders: summaries.length,
      afterLookbackAndRegex: candidates.length,
      mailbox: openedMailbox,
    };

    const detailUids = candidates.map((c) => c.uid);
    const withSource = await client.fetchAll(detailUids, {
      uid: true,
      source: true,
      envelope: true,
      internalDate: true,
    });

    const secondPullExpected = candidates.length;
    const secondPullReturned = withSource.length;
    if (secondPullReturned < secondPullExpected) {
      logScanner("warn", "Second fetch returned fewer messages than header-stage candidates", {
        email: account.email,
        secondPullExpected,
        secondPullReturned,
      });
    }

    const secondByUid = new Map(withSource.map((m) => [m.uid, m]));

    // Newest first: when multiple RESCHEDULEs share one ISA id, first processed row wins; older ones skip.
    // Always iterate **header-stage candidates** so a failed/empty BODY fetch cannot drop every row.
    const sortedCandidates = [...candidates].sort((a, b) => {
      const ta = internalDateAsDate(a.internalDate).getTime();
      const tb = internalDateAsDate(b.internalDate).getTime();
      return tb - ta;
    });

    let subjectMissAfterBodyFetch = 0;
    let dbFailures = 0;

    for (const cand of sortedCandidates) {
      const second = secondByUid.get(cand.uid);
      const envelope = second?.envelope ?? cand.envelope;
      const internalDate = second?.internalDate ?? cand.internalDate;

      // Gmail list + thread row use IMAP ENVELOPE subject — do not replace with mailparser `subject`
      // (parsed subject can differ from the RFC822 header Amazon set).
      const subject = envelope?.subject?.trim() ?? "";
      // Prefer `String.match` over `RegExp.exec` on a shared regex (avoids `lastIndex` edge cases).
      const match = subject.match(SUBJECT_RESCHEDULE_REGEX);
      if (!match) {
        subjectMissAfterBodyFetch += 1;
        continue;
      }

      // "Received" in UI = when Gmail stored the message, not the email's Date: header (often wrong).
      const receivedAt = internalDateAsDate(internalDate);

      const fromList = envelope?.from?.[0];
      let fromEmail = fromList?.address ?? fromList?.name ?? "";
      let gmailMessageId = normalizeMessageId(
        envelope?.messageId,
        account.email,
        cand.uid,
      );

      if (second?.source) {
        try {
          const parsed = await simpleParser(second.source);
          const fromAddr = parsed.from?.value?.[0];
          if (fromAddr?.address || fromAddr?.name) {
            fromEmail = fromAddr.address ?? fromAddr.name ?? fromEmail;
          }
          if (parsed.messageId?.trim()) {
            gmailMessageId = normalizeMessageId(parsed.messageId, account.email, cand.uid);
          }
        } catch (e) {
          logScanner("warn", "mailparser failed; using envelope from only", {
            email: account.email,
            uid: cand.uid,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      const appointmentId = match[2];
      const rowData = {
        region: account.region,
        warehouse: match[1],
        appointmentTimeText: match[3].trim(),
        subject,
        fromEmail,
        receivedAt,
        gmailMessageId,
      };

      try {
        const existing = await prisma.amazonRescheduleEmail.findUnique({
          where: {
            emailAccount_appointmentId: {
              emailAccount: account.email,
              appointmentId,
            },
          },
        });

        if (!existing) {
          await prisma.amazonRescheduleEmail.create({
            data: {
              emailAccount: account.email,
              appointmentId,
              ...rowData,
            },
          });
          result.inserted += 1;
          result.highlights?.push({
            emailAccount: account.email,
            warehouse: rowData.warehouse,
            appointmentId,
            appointmentTimeText: rowData.appointmentTimeText,
            receivedAt: rowData.receivedAt.toISOString(),
            action: "created",
          });
        } else if (receivedAt.getTime() > existing.receivedAt.getTime()) {
          await prisma.amazonRescheduleEmail.update({
            where: { id: existing.id },
            data: rowData,
          });
          result.inserted += 1;
          result.highlights?.push({
            emailAccount: account.email,
            warehouse: rowData.warehouse,
            appointmentId,
            appointmentTimeText: rowData.appointmentTimeText,
            receivedAt: rowData.receivedAt.toISOString(),
            action: "updated",
          });
        } else {
          result.skipped += 1;
        }
      } catch (e: unknown) {
        dbFailures += 1;
        const detail = formatPrismaError(e);
        if (!result.dbError) {
          result.dbError = detail;
        }
        logScanner("error", "Failed to upsert row", {
          email: account.email,
          appointmentId,
          error: detail,
        });
      }
    }

    result.stats = {
      ...result.stats!,
      dbFailures,
      subjectMissAfterBodyFetch,
      secondPullExpected,
      secondPullReturned,
    };

    if (
      result.inserted === 0 &&
      result.skipped === 0 &&
      (result.stats?.afterLookbackAndRegex ?? 0) > 0 &&
      !result.note
    ) {
      const n = result.stats!.afterLookbackAndRegex;
      if (dbFailures > 0 && result.dbError) {
        const migrateHint =
          /P2002|Unique constraint|gmailMessageId/i.test(result.dbError)
            ? " 常见原因：数据库仍是旧迁移（`gmailMessageId` 全局 UNIQUE），与当前代码不一致；在本仓库执行 `npx prisma migrate deploy` 后再扫。"
            : "";
        result.note = `有 ${n} 封候选信，但 ${dbFailures} 次写入失败。首条错误：${result.dbError}.${migrateHint}`;
      } else if (
        sortedCandidates.length > 0 &&
        subjectMissAfterBodyFetch === sortedCandidates.length
      ) {
        result.note = `有 ${n} 封候选信（头信息阶段通过），但在合并二次拉取结果后，仍有 ${subjectMissAfterBodyFetch} 封的主题行未匹配 RESCHEDULE 正则（编码/折叠主题差异）。`;
      } else if (secondPullReturned === 0 && secondPullExpected > 0) {
        result.note = `有 ${n} 封候选信，但带正文的二次 IMAP 拉取返回 0 封（预期 ${secondPullExpected}）。此前误报的「主题未匹配」多由此引起；请查看终端 [gmail-scanner] Second fetch 相关日志或重试扫描。`;
      } else {
        result.note = `有 ${n} 封候选信，但未计入新增/跳过（写入失败 ${dbFailures}，合并后主题未匹配 ${subjectMissAfterBodyFetch}；二次拉取 ${secondPullReturned}/${secondPullExpected}）。`;
      }
    }
  } catch (e) {
    result.ok = false;
    result.error = imapErrorDetails(e);
    logScanner("error", "IMAP scan failed for account", {
      email: account.email,
      error: result.error,
    });
  } finally {
    try {
      await client.logout();
    } catch {
      try {
        client.close();
      } catch {
        /* ignore */
      }
    }
  }

  return result;
}

export async function scanAllGmailAccounts(): Promise<ScanGmailResult> {
  const accounts = parseGmailAccountsFromEnv();
  const accountsOut: AccountScanResult[] = [];
  const highlights: ScanGmailResult["highlights"] = [];
  let inserted = 0;
  let skipped = 0;

  for (const account of accounts) {
    const one = await scanAccount(account);
    accountsOut.push(one);
    if (one.highlights?.length) {
      highlights.push(...one.highlights);
    }
    inserted += one.inserted;
    skipped += one.skipped;
  }

  return {
    success: true,
    scannedAccounts: accountsOut.length,
    inserted,
    skipped,
    accounts: accountsOut,
    highlights,
  };
}
