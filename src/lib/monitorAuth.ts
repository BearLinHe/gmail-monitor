import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

export const MONITOR_SESSION_COOKIE = "gmail_monitor_session";
export const GMAIL_OAUTH_STATE_COOKIE = "gmail_monitor_oauth_state";
export const SESSION_SECONDS = 8 * 60 * 60;
export const OAUTH_STATE_SECONDS = 10 * 60;

export function getMonitorAdminPassword(): string | null {
  const password = process.env.GMAIL_MONITOR_ADMIN_PASSWORD?.trim();
  return password && password.length >= 32 ? password : null;
}

export function secretsMatch(value: string, secret: string): boolean {
  const digest = (input: string) => createHash("sha256").update(input).digest();
  return timingSafeEqual(digest(value), digest(secret));
}

type Session = { id: string; expiresAt: number };
type OAuthAttempt = {
  sessionId: string;
  email: string;
  region: string;
  state: string;
  codeVerifier: string;
  expiresAt: number;
};

function signValue(purpose: "session" | "oauth", body: string, password: string): string {
  return createHmac("sha256", password).update(`gmail-monitor:${purpose}:${body}`).digest("base64url");
}

function seal(purpose: "session" | "oauth", value: Session | OAuthAttempt, password: string): string {
  const body = Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${body}.${signValue(purpose, body, password)}`;
}

function open<T extends { expiresAt: number }>(
  purpose: "session" | "oauth",
  value: string | undefined,
  password: string,
): T | null {
  if (!value || value.length > 2048) return null;
  const [body, signature, extra] = value.split(".");
  if (!body || !signature || extra !== undefined || !secretsMatch(signature, signValue(purpose, body, password))) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
    return Number.isFinite(parsed.expiresAt) && parsed.expiresAt > Date.now() ? parsed : null;
  } catch {
    return null;
  }
}

export function createMonitorSession(password: string): string {
  return seal("session", {
    id: randomBytes(24).toString("base64url"),
    expiresAt: Date.now() + SESSION_SECONDS * 1000,
  }, password);
}

export function getMonitorSession(request: NextRequest): Session | null {
  const password = getMonitorAdminPassword();
  return password
    ? open<Session>("session", request.cookies.get(MONITOR_SESSION_COOKIE)?.value, password)
    : null;
}

export function sealOAuthAttempt(attempt: Omit<OAuthAttempt, "expiresAt">, password: string): string {
  return seal("oauth", { ...attempt, expiresAt: Date.now() + OAUTH_STATE_SECONDS * 1000 }, password);
}

export function getOAuthAttempt(request: NextRequest, password: string): OAuthAttempt | null {
  return open<OAuthAttempt>("oauth", request.cookies.get(GMAIL_OAUTH_STATE_COOKIE)?.value, password);
}

function configuredOrigin(): string | null {
  const redirect = process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim();
  if (!redirect) return null;
  try {
    return new URL(redirect).origin;
  } catch {
    return null;
  }
}

export function isMonitorSameOrigin(request: NextRequest): boolean {
  return request.headers.get("origin") === (configuredOrigin() ?? request.nextUrl.origin);
}

export function monitorCookieOptions(request: NextRequest, maxAge: number, path = "/") {
  const origin = configuredOrigin() ?? request.nextUrl.origin;
  return { httpOnly: true, secure: origin.startsWith("https://"), sameSite: "lax" as const, path, maxAge };
}
