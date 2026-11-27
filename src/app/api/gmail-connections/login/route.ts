import { NextRequest, NextResponse } from "next/server";

import {
  createMonitorSession,
  getMonitorAdminPassword,
  isMonitorSameOrigin,
  MONITOR_SESSION_COOKIE,
  monitorCookieOptions,
  secretsMatch,
  SESSION_SECONDS,
} from "@/lib/monitorAuth";

export async function POST(request: NextRequest) {
  const headers = { "Cache-Control": "no-store" };
  if (!isMonitorSameOrigin(request)) {
    return NextResponse.json({ error: "Open the monitor directly and try again." }, { status: 403, headers });
  }

  const configuredPassword = getMonitorAdminPassword();
  if (!configuredPassword) {
    return NextResponse.json({ error: "Monitor sign-in is not configured." }, { status: 503, headers });
  }

  const body = await request.json().catch(() => null);
  const password: unknown = body?.password;
  if (typeof password !== "string" || password.length > 1024 || !secretsMatch(password, configuredPassword)) {
    return NextResponse.json({ error: "Incorrect monitor password." }, { status: 401, headers });
  }

  const response = NextResponse.json({ ok: true }, { headers });
  response.cookies.set(MONITOR_SESSION_COOKIE, createMonitorSession(configuredPassword), monitorCookieOptions(request, SESSION_SECONDS));
  return response;
}
