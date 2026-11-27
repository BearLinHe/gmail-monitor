import { createHash, randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { buildGmailAuthorizationUrl, getGmailOAuthConfig, GMAIL_OAUTH_CALLBACK_PATH } from "@/lib/gmailOAuth";
import {
  getMonitorAdminPassword,
  getMonitorSession,
  GMAIL_OAUTH_STATE_COOKIE,
  isMonitorSameOrigin,
  monitorCookieOptions,
  OAUTH_STATE_SECONDS,
  sealOAuthAttempt,
} from "@/lib/monitorAuth";

export async function POST(request: NextRequest) {
  const headers = { "Cache-Control": "no-store" };
  if (!isMonitorSameOrigin(request)) {
    return NextResponse.json({ error: "Open the monitor directly and try again." }, { status: 403, headers });
  }

  const session = getMonitorSession(request);
  const password = getMonitorAdminPassword();
  if (!session || !password) {
    return NextResponse.json({ error: "Sign in to the monitor first." }, { status: 401, headers });
  }

  const body = await request.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  const region = typeof body?.region === "string" ? body.region.trim() : "";
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return NextResponse.json({ error: "Enter a valid Google mailbox address." }, { status: 400, headers });
  }
  if (!region || region.length > 32 || /[\u0000-\u001f\u007f]/.test(region)) {
    return NextResponse.json({ error: "Enter a region of up to 32 characters." }, { status: 400, headers });
  }

  try {
    const config = getGmailOAuthConfig();
    if (!config) {
      return NextResponse.json({ error: "Google OAuth is not configured for this monitor." }, { status: 503, headers });
    }

    const state = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const url = buildGmailAuthorizationUrl(config, { email, state, codeChallenge });
    const response = NextResponse.json({ url: url.toString() }, { headers });
    response.cookies.set(
      GMAIL_OAUTH_STATE_COOKIE,
      sealOAuthAttempt({ email, region, state, codeVerifier, sessionId: session.id }, password),
      monitorCookieOptions(request, OAUTH_STATE_SECONDS, GMAIL_OAUTH_CALLBACK_PATH),
    );
    return response;
  } catch {
    return NextResponse.json({ error: "Check the monitor's Google OAuth settings." }, { status: 503, headers });
  }
}
