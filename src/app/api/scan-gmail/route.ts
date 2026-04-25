import { NextResponse } from "next/server";

import {
  parseGmailAccountsFromEnvDetailed,
  scanAllGmailAccounts,
} from "@/lib/gmailScanner";
import { cleanupOldData } from "@/lib/dataMaintenance";
import { notifyWechatIfNeeded } from "@/lib/wechatNotifier";

export const dynamic = "force-dynamic";

export async function POST() {
  const { accounts, error: parseError } = parseGmailAccountsFromEnvDetailed();
  if (accounts.length === 0) {
    return NextResponse.json(
      {
        success: false,
        error: parseError ?? "No valid Gmail accounts in GMAIL_ACCOUNTS_JSON",
        scannedAccounts: 0,
        inserted: 0,
        skipped: 0,
        accounts: [],
      },
      { status: 400 },
    );
  }

  try {
    const result = await scanAllGmailAccounts();
    await notifyWechatIfNeeded(result, "manual");
    const maintenance = await cleanupOldData();

    return NextResponse.json({
      success: result.success,
      scannedAccounts: result.scannedAccounts,
      inserted: result.inserted,
      skipped: result.skipped,
      accounts: result.accounts,
      highlights: result.highlights,
      maintenance,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Scan failed";
    console.error("[api/scan-gmail]", message, e);
    return NextResponse.json(
      {
        success: false,
        error: message,
        scannedAccounts: accounts.length,
        inserted: 0,
        skipped: 0,
        accounts: [],
      },
      { status: 500 },
    );
  }
}
