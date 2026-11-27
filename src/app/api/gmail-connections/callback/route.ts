import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import {
  encryptGmailRefreshToken,
  exchangeGmailAuthorizationCode,
  getGmailOAuthConfig,
  getGmailProfileEmail,
  GMAIL_OAUTH_CALLBACK_PATH,
  refreshGmailAccessToken,
} from "@/lib/gmailOAuth";
import {
  getMonitorAdminPassword,
  getMonitorSession,
  getOAuthAttempt,
  GMAIL_OAUTH_STATE_COOKIE,
  monitorCookieOptions,
  secretsMatch,
} from "@/lib/monitorAuth";
import { prisma } from "@/lib/prisma";

type ConnectionResult = "connected" | "denied" | "invalid" | "wrong_account" | "failed";

export async function GET(request: NextRequest) {
  let baseUrl = request.url;
  function finish(result: ConnectionResult) {
    const target = new URL("/gmail-connections", baseUrl);
    target.searchParams.set("result", result);
    const response = NextResponse.redirect(target, 303);
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("Referrer-Policy", "no-referrer");
    response.cookies.set(GMAIL_OAUTH_STATE_COOKIE, "", monitorCookieOptions(request, 0, GMAIL_OAUTH_CALLBACK_PATH));
    return response;
  }

  try {
    const config = getGmailOAuthConfig();
    if (!config) return finish("failed");
    baseUrl = config.redirectUri;

    const password = getMonitorAdminPassword();
    const session = getMonitorSession(request);
    const attempt = password ? getOAuthAttempt(request, password) : null;
    const params = request.nextUrl.searchParams;
    const state = params.get("state");
    if (!session || !attempt || attempt.sessionId !== session.id || !state || !secretsMatch(state, attempt.state)) {
      return finish("invalid");
    }

    if (params.has("error")) return finish(params.get("error") === "access_denied" ? "denied" : "failed");
    const code = params.get("code");
    if (!code) return finish("invalid");

    const tokens = await exchangeGmailAuthorizationCode(config, { code, codeVerifier: attempt.codeVerifier });
    if (await getGmailProfileEmail(tokens.accessToken) !== attempt.email) return finish("wrong_account");
    if (!tokens.refreshToken) return finish("failed");

    // Try offline access before supplanting the existing connection or IMAP configuration.
    const refreshed = await refreshGmailAccessToken(config, tokens.refreshToken);
    if (await getGmailProfileEmail(refreshed.accessToken) !== attempt.email) return finish("wrong_account");
    const encryptedRefreshToken = encryptGmailRefreshToken(config, refreshed.refreshToken ?? tokens.refreshToken, attempt.email);
    const data = {
      region: attempt.region,
      authorizationId: randomUUID(),
      encryptedRefreshToken,
      needsReconnect: false,
      lastScanAt: null,
    };
    await prisma.gmailConnection.upsert({
      where: { email: attempt.email },
      create: { email: attempt.email, ...data },
      update: data,
    });
    return finish("connected");
  } catch {
    console.error("[gmail-connections] Gmail authorization could not be completed");
    return finish("failed");
  }
}
