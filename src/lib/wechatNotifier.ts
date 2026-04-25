import type { ScanGmailResult } from "@/lib/gmailScanner";
import { prisma } from "@/lib/prisma";

type NotifyTrigger = "manual" | "cron";
type Highlight = ScanGmailResult["highlights"][number];
type ThrottleRow = { key: string; last_notified_at: Date | string };

const THROTTLE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS scan_notification_throttle (
  key TEXT PRIMARY KEY,
  last_notified_at TIMESTAMPTZ NOT NULL
)`;

function truncateHighlights(items: ScanGmailResult["highlights"], max = 12) {
  return items.slice(0, max);
}

function formatLocalTime(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function buildMessage(
  result: ScanGmailResult,
  trigger: NotifyTrigger,
  effectiveHighlights: Highlight[],
): string {
  const title = trigger === "cron" ? "Gmail 自动扫描提醒" : "Gmail 手动扫描提醒";
  const lines: string[] = [];
  lines.push(`${title}`);
  lines.push(`新增/更新: ${result.inserted} 条`);
  lines.push(`本次通知: ${effectiveHighlights.length} 条（已按 appointment 30 分钟去重）`);
  lines.push(`扫描账号: ${result.scannedAccounts} 个`);
  lines.push("");

  const items = truncateHighlights(effectiveHighlights);
  if (items.length === 0) {
    lines.push("本轮新增均在节流窗口内，未重复推送。");
    return lines.join("\n");
  }

  lines.push("明细:");
  for (const item of items) {
    lines.push(
      `- ${item.emailAccount} | ${item.warehouse} | #${item.appointmentId} | ${item.appointmentTimeText} | ${formatLocalTime(item.receivedAt)}`,
    );
  }
  if (effectiveHighlights.length > items.length) {
    lines.push(`- ... 其余 ${effectiveHighlights.length - items.length} 条省略`);
  }
  return lines.join("\n");
}

function throttleWindowMs(): number {
  const raw = process.env.NOTIFY_THROTTLE_MINUTES?.trim();
  const minutes = raw ? Math.floor(Number(raw)) : 30;
  if (!Number.isFinite(minutes) || minutes < 1) return 30 * 60 * 1000;
  return minutes * 60 * 1000;
}

function throttleKey(one: Highlight): string {
  return `${one.emailAccount.toLowerCase()}::${one.appointmentId}`;
}

async function ensureThrottleTable(): Promise<void> {
  await prisma.$executeRawUnsafe(THROTTLE_TABLE_SQL);
}

async function filterHighlightsByThrottle(highlights: Highlight[]): Promise<Highlight[]> {
  if (highlights.length === 0) return [];
  await ensureThrottleTable();
  const windowMs = throttleWindowMs();
  const nowMs = Date.now();
  const accepted: Highlight[] = [];

  const seenInBatch = new Set<string>();
  for (const one of highlights) {
    const key = throttleKey(one);
    if (seenInBatch.has(key)) continue;
    seenInBatch.add(key);

    const rows = (await prisma.$queryRawUnsafe(
      "SELECT key, last_notified_at FROM scan_notification_throttle WHERE key = $1 LIMIT 1",
      key,
    )) as ThrottleRow[];
    if (rows.length === 0) {
      accepted.push(one);
      continue;
    }
    const last = rows[0].last_notified_at;
    const lastMs = new Date(last).getTime();
    if (!Number.isFinite(lastMs) || nowMs - lastMs >= windowMs) {
      accepted.push(one);
    }
  }
  return accepted;
}

async function markHighlightsNotified(highlights: Highlight[]): Promise<void> {
  if (highlights.length === 0) return;
  await ensureThrottleTable();
  const nowIso = new Date().toISOString();
  for (const one of highlights) {
    const key = throttleKey(one);
    await prisma.$executeRawUnsafe(
      `INSERT INTO scan_notification_throttle (key, last_notified_at)
       VALUES ($1, $2::timestamptz)
       ON CONFLICT (key) DO UPDATE SET last_notified_at = EXCLUDED.last_notified_at`,
      key,
      nowIso,
    );
  }
}

async function sendToWeComBot(webhookUrl: string, message: string): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      msgtype: "text",
      text: {
        content: message,
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`WeCom webhook failed (${res.status}): ${body.slice(0, 300)}`);
  }
}

async function sendToServerChan(sendKey: string, message: string): Promise<void> {
  const endpoint = `https://sctapi.ftqq.com/${encodeURIComponent(sendKey)}.send`;
  const body = new URLSearchParams({
    title: "Gmail 监控有新数据",
    desp: message,
  });
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ServerChan failed (${res.status}): ${text.slice(0, 300)}`);
  }
}

/**
 * Sends WeChat notifications for newly saved rows.
 * - WeCom: set `WECOM_BOT_WEBHOOK_URL`
 * - Personal WeChat (Server酱): set `SERVERCHAN_SENDKEY`
 */
export async function notifyWechatIfNeeded(
  result: ScanGmailResult,
  trigger: NotifyTrigger,
): Promise<void> {
  if (result.inserted < 1) return;
  if (result.highlights.length === 0) return;

  const effectiveHighlights = await filterHighlightsByThrottle(result.highlights);
  if (effectiveHighlights.length === 0) {
    return;
  }
  const message = buildMessage(result, trigger, effectiveHighlights);
  const wecomWebhook = process.env.WECOM_BOT_WEBHOOK_URL?.trim();
  const serverChanSendKey = process.env.SERVERCHAN_SENDKEY?.trim();

  if (!wecomWebhook && !serverChanSendKey) {
    return;
  }

  const errors: string[] = [];
  let sent = false;
  if (wecomWebhook) {
    try {
      await sendToWeComBot(wecomWebhook, message);
      sent = true;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (serverChanSendKey) {
    try {
      await sendToServerChan(serverChanSendKey, message);
      sent = true;
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (sent) {
    await markHighlightsNotified(effectiveHighlights);
  }
  if (errors.length > 0) {
    console.error("[wechat-notifier]", { errors });
  }
}
