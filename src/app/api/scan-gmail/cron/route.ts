import { NextRequest, NextResponse } from "next/server";

import { runGmailScan } from "@/lib/gmailScanJob";
import { secretsMatch } from "@/lib/monitorAuth";

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
  if (!secretsMatch(provided, secret)) {
    return unauthorized();
  }

  try {
    const result = await runGmailScan("cron");
    const status = !result.scannedAccounts ? 400 : result.success ? 200 : 502;
    return NextResponse.json({ ...result, trigger: "cron" }, { status, headers: { "Cache-Control": "no-store" } });
  } catch {
    console.error("[api/scan-gmail/cron] Could not run the scheduled scan");
    return NextResponse.json({ success: false, error: "Could not run the scan. Check server settings and logs." }, { status: 500 });
  }
}
