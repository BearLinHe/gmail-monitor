import { NextRequest, NextResponse } from "next/server";

import { runGmailScan } from "@/lib/gmailScanJob";
import { getMonitorSession, isMonitorSameOrigin } from "@/lib/monitorAuth";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  if (!getMonitorSession(request)) {
    return NextResponse.json({ success: false, error: "Sign in to the monitor first." }, { status: 401 });
  }
  if (!isMonitorSameOrigin(request)) {
    return NextResponse.json({ success: false, error: "Open the monitor directly to start a scan." }, { status: 403 });
  }

  try {
    const result = await runGmailScan("manual");
    return NextResponse.json(result, { status: result.scannedAccounts ? 200 : 400 });
  } catch {
    console.error("[api/scan-gmail] Could not run the scan");
    return NextResponse.json({ success: false, error: "Could not run the scan. Check server settings and logs." }, { status: 500 });
  }
}
