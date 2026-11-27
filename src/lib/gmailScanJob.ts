import { cleanupOldData } from "@/lib/dataMaintenance";
import { scanAllGmailAccounts } from "@/lib/gmailScanner";
import { notifyWechatIfNeeded } from "@/lib/wechatNotifier";

export async function runGmailScan(trigger: "manual" | "cron") {
  const result = await scanAllGmailAccounts();
  if (!result.scannedAccounts) {
    return { ...result, error: result.configurationError ?? "Connect at least one Gmail mailbox first." };
  }

  const [notification, maintenance] = await Promise.allSettled([
    notifyWechatIfNeeded(result, trigger),
    cleanupOldData(),
  ]);
  if (notification.status === "rejected") console.error("[gmail-scan] Notification failed");
  if (maintenance.status === "rejected") console.error("[gmail-scan] Maintenance failed");

  return { ...result, maintenance: maintenance.status === "fulfilled" ? maintenance.value : null };
}
