import { NextRequest, NextResponse } from "next/server";

import {
  parseGmailAccountsFromEnvDetailed,
  scanAllGmailAccounts,
} from "@/lib/gmailScanner";
import { cleanupOldData } from "@/lib/dataMaintenance";
import { notifyWechatIfNeeded } from "@/lib/wechatNotifier";

export const dynamic = "force-dynamic";

function unauthorized() {
  return NextResponse.json(
    {
      success: false,
      error: "Unauthorized",
    },
    { status: 401 },
  );
}

export async function GET(request: NextRequest) {
  const secret = process.env.SCAN_CRON_SECRET?.trim() || process.env.CRON_SECRET?.trim();
  if (!secret) {
    return NextResponse.json(
      {
        success: false,
        error: "SCAN_CRON_SECRET or CRON_SECRET is not set",
      },
      { status: 500 },
    );
  }

  const authHeader = request.headers.get("authorization") ?? "";
  const bearer = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const querySecret = request.nextUrl.searchParams.get("secret")?.trim() ?? "";
  const provided = bearer || querySecret;
  if (provided !== secret) {
    return unauthorized();
  }

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
    await notifyWechatIfNeeded(result, "cron");
    const maintenance = await cleanupOldData();
    return NextResponse.json({
      success: result.success,
      trigger: "cron",
      scannedAccounts: result.scannedAccounts,
      inserted: result.inserted,
      skipped: result.skipped,
      accounts: result.accounts,
      highlights: result.highlights,
      maintenance,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Scan failed";
    console.error("[api/scan-gmail/cron]", message, e);
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
