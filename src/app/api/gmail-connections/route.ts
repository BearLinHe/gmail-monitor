import { NextRequest, NextResponse } from "next/server";

import { getGmailOAuthConfig } from "@/lib/gmailOAuth";
import { parseGmailAccountsFromEnv } from "@/lib/gmailScanner";
import { getMonitorAdminPassword, getMonitorSession } from "@/lib/monitorAuth";
import { prisma } from "@/lib/prisma";

const noStore = { "Cache-Control": "no-store" };

export async function GET(request: NextRequest) {
  const adminConfigured = Boolean(getMonitorAdminPassword());
  const authenticated = Boolean(getMonitorSession(request));
  let enabled = false;
  try {
    enabled = adminConfigured && Boolean(getGmailOAuthConfig());
  } catch {
    return NextResponse.json({ enabled, adminConfigured, authenticated, accounts: [] }, { headers: noStore });
  }

  if (!authenticated) {
    return NextResponse.json({ enabled, adminConfigured, authenticated, accounts: [] }, { headers: noStore });
  }

  try {
    const connected = enabled ? await prisma.gmailConnection.findMany({
      select: { email: true, region: true, needsReconnect: true, lastScanAt: true },
    }) : [];
    const accounts = new Map(parseGmailAccountsFromEnv().map(({ email, region }) => [
      email.trim().toLowerCase(),
      { email, region, status: "legacy", lastScanAt: null as Date | null },
    ]));

    for (const { email, region, needsReconnect, lastScanAt } of connected) {
      accounts.set(email, { email, region, status: needsReconnect ? "reconnect" : "connected", lastScanAt });
    }

    return NextResponse.json({
      enabled,
      adminConfigured,
      authenticated,
      accounts: Array.from(accounts.values()).sort((a, b) => a.email.localeCompare(b.email)),
    }, { headers: noStore });
  } catch {
    console.error("[gmail-connections] Failed to read mailbox connections");
    return NextResponse.json({ error: "Could not load mailbox connections." }, { status: 503, headers: noStore });
  }
}
