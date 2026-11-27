import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_API_URL = "https://gmail.googleapis.com/gmail/v1/users/me/";
const REQUEST_TIMEOUT_MS = 10_000;
const HEADER_FETCH_CONCURRENCY = 8;
export const GMAIL_OAUTH_CALLBACK_PATH = "/api/gmail-connections/callback";

export type GmailOAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  tokenKey: Buffer;
};

export class GmailOAuthError extends Error {
  constructor(message: string, readonly needsReconnect = false) {
    super(message);
    this.name = "GmailOAuthError";
  }
}

export function getGmailOAuthConfig(): GmailOAuthConfig | null {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  const redirectUri = process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim();
  const encodedKey = process.env.GMAIL_OAUTH_TOKEN_KEY?.trim();

  if (!clientId && !clientSecret && !redirectUri && !encodedKey) return null;
  if (!clientId || !clientSecret || !redirectUri || !encodedKey) {
    throw new GmailOAuthError("Google OAuth configuration is incomplete.");
  }

  const parsedRedirect = URL.canParse(redirectUri) ? new URL(redirectUri) : null;
  const localHttp =
    parsedRedirect?.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(parsedRedirect.hostname);
  if (
    !parsedRedirect ||
    (parsedRedirect.protocol !== "https:" && !localHttp) ||
    parsedRedirect.pathname !== GMAIL_OAUTH_CALLBACK_PATH ||
    parsedRedirect.search ||
    parsedRedirect.hash ||
    parsedRedirect.username ||
    parsedRedirect.password
  ) {
    throw new GmailOAuthError(
      `GOOGLE_OAUTH_REDIRECT_URI must point to ${GMAIL_OAUTH_CALLBACK_PATH} over HTTPS or local HTTP.`,
    );
  }

  const tokenKey = Buffer.from(encodedKey, "base64");
  if (
    tokenKey.length !== 32 ||
    (encodedKey !== tokenKey.toString("base64") &&
      encodedKey !== tokenKey.toString("base64").replace(/=+$/, ""))
  ) {
    throw new GmailOAuthError("GMAIL_OAUTH_TOKEN_KEY must contain 32 bytes encoded as base64.");
  }

  return { clientId, clientSecret, redirectUri, tokenKey };
}

export function buildGmailAuthorizationUrl(
  config: GmailOAuthConfig,
  request: { state: string; codeChallenge: string; email: string },
): URL {
  const url = new URL(GOOGLE_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: GMAIL_READONLY,
    access_type: "offline",
    prompt: "consent",
    login_hint: request.email,
    state: request.state,
    code_challenge: request.codeChallenge,
    code_challenge_method: "S256",
  }).toString();
  return url;
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  scope?: string;
  error?: string;
};

async function googleFetch(url: URL | string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new GmailOAuthError("Google could not be reached. Try again.");
  }
}

async function requestTokens(
  config: GmailOAuthConfig,
  parameters: Record<string, string>,
): Promise<{ accessToken: string; refreshToken?: string }> {
  const response = await googleFetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      ...parameters,
    }),
  });
  const result = (await response.json().catch(() => null)) as TokenResponse | null;
  const isRefresh = parameters.grant_type === "refresh_token";
  if (!response.ok) {
    if (isRefresh && result?.error === "invalid_grant") {
      throw new GmailOAuthError("Google authorization expired or was revoked. Reconnect this mailbox.", true);
    }
    throw new GmailOAuthError(
      response.status === 429 || response.status >= 500
        ? "Google authorization is temporarily unavailable. Try again."
        : "Google did not accept the authorization request.",
    );
  }
  if (typeof result?.access_token !== "string" || !result.access_token) {
    throw new GmailOAuthError("Google did not return a usable access token.");
  }
  if (result.scope !== undefined && (
    typeof result.scope !== "string" || !result.scope.split(/\s+/).includes(GMAIL_READONLY)
  )) {
    throw new GmailOAuthError("Gmail read-only access was not granted.", isRefresh);
  }
  return {
    accessToken: result.access_token,
    refreshToken: typeof result.refresh_token === "string" && result.refresh_token
      ? result.refresh_token
      : undefined,
  };
}

export function exchangeGmailAuthorizationCode(
  config: GmailOAuthConfig,
  request: { code: string; codeVerifier: string },
) {
  return requestTokens(config, {
    grant_type: "authorization_code",
    redirect_uri: config.redirectUri,
    code: request.code,
    code_verifier: request.codeVerifier,
  });
}

export function refreshGmailAccessToken(config: GmailOAuthConfig, refreshToken: string) {
  return requestTokens(config, { grant_type: "refresh_token", refresh_token: refreshToken });
}

function tokenContext(email: string): Buffer {
  return Buffer.from(`gmail-monitor:refresh-token:v1:${email.trim().toLowerCase()}`, "utf8");
}

export function encryptGmailRefreshToken(
  config: GmailOAuthConfig,
  refreshToken: string,
  email: string,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", config.tokenKey, iv, { authTagLength: 16 });
  cipher.setAAD(tokenContext(email));
  const encrypted = Buffer.concat([cipher.update(refreshToken, "utf8"), cipher.final()]);
  return ["v1", ...[iv, cipher.getAuthTag(), encrypted].map((value) => value.toString("base64url"))].join(".");
}

export function decryptGmailRefreshToken(
  config: GmailOAuthConfig,
  ciphertext: string,
  email: string,
): string {
  try {
    const fields = /^v1\.([A-Za-z0-9_-]{16})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]+)$/.exec(ciphertext);
    if (!fields) {
      throw new Error("Invalid encrypted token format");
    }
    const [, iv, tag, encrypted] = fields;
    const decipher = createDecipheriv("aes-256-gcm", config.tokenKey, Buffer.from(iv, "base64url"), {
      authTagLength: 16,
    });
    decipher.setAAD(tokenContext(email));
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new GmailOAuthError("The stored Gmail authorization could not be decrypted. Check the server token key.");
  }
}

type GmailErrorBody = {
  error?: {
    errors?: Array<{ reason?: string }>;
    details?: Array<{ reason?: string }>;
  };
};

async function gmailGet<T>(
  accessToken: string,
  path: string,
  query?: URLSearchParams,
  allowNotFound = false,
): Promise<T | null> {
  const url = new URL(path, GMAIL_API_URL);
  if (query) url.search = query.toString();
  const response = await googleFetch(url, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (response.status === 404 && allowNotFound) return null;
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const body = result as GmailErrorBody | null;
    const errors = body?.error?.errors;
    const details = body?.error?.details;
    const insufficientScope = response.status === 403 && (
      (Array.isArray(errors) && errors.some((error) => error?.reason === "insufficientPermissions")) ||
      (Array.isArray(details) && details.some((detail) => detail?.reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT"))
    );
    if (response.status === 401 || insufficientScope) {
      throw new GmailOAuthError("Gmail access was denied. Reconnect this mailbox.", true);
    }
    if (response.status === 429 || response.status >= 500) {
      throw new GmailOAuthError("Gmail is temporarily unavailable or rate-limited. Try again.");
    }
    throw new GmailOAuthError(`Gmail could not complete the request (HTTP ${response.status}).`);
  }
  if (result === null || typeof result !== "object") {
    throw new GmailOAuthError("Gmail returned an invalid response.");
  }
  return result as T;
}

export async function getGmailProfileEmail(accessToken: string): Promise<string> {
  const profile = await gmailGet<{ emailAddress?: string }>(
    accessToken,
    "profile",
    new URLSearchParams({ fields: "emailAddress" }),
  );
  const email = typeof profile?.emailAddress === "string" && profile.emailAddress.trim().toLowerCase();
  if (!email) throw new GmailOAuthError("Google could not identify the authorized Gmail address.");
  return email;
}

type MessagePage = {
  messages?: Array<{ id?: string }>;
  nextPageToken?: string;
};

type MessageMetadata = {
  internalDate?: string;
  payload?: { headers?: Array<{ name: string; value: string }> };
};

type GmailRescheduleMessage = {
  subject: string;
  fromEmail: string;
  receivedAt: Date;
  gmailMessageId: string;
};

async function getGmailMessageMetadata(
  accessToken: string,
  id: string,
  cutoffMs: number,
): Promise<GmailRescheduleMessage | null> {
  const query = new URLSearchParams({
    format: "metadata",
    fields: "internalDate,payload(headers)",
  });
  for (const header of ["Subject", "From", "Message-ID"]) query.append("metadataHeaders", header);

  const message = await gmailGet<MessageMetadata>(
    accessToken, `messages/${encodeURIComponent(id)}`, query, true,
  );
  if (!message?.internalDate) return null;
  const receivedAt = new Date(Number(message.internalDate));
  if (!Number.isFinite(receivedAt.getTime()) || receivedAt.getTime() < cutoffMs) return null;

  const header = (name: string) =>
    message.payload?.headers?.find((item) => item.name.toLowerCase() === name)?.value.trim() ?? "";
  const subject = header("subject");
  if (!subject) return null;
  const from = header("from");
  const fromEmail = from.match(/<([^<>]+)>/)?.[1]?.trim() ?? from;
  const gmailMessageId = header("message-id").replace(/^<|>$/g, "") || id;
  return { subject, fromEmail, receivedAt, gmailMessageId };
}

export async function listGmailRescheduleMessages(
  accessToken: string,
  cutoffMs: number,
): Promise<GmailRescheduleMessage[]> {
  const messages: GmailRescheduleMessage[] = [];
  const seenIds = new Set<string>();
  const seenPageTokens = new Set<string>();
  const query = new URLSearchParams({
    q: `after:${Math.floor(cutoffMs / 1000) - 1} subject:RESCHEDULE subject:Appointment`,
    maxResults: "500",
    fields: "messages(id),nextPageToken",
  });
  do {
    const page = await gmailGet<MessagePage>(accessToken, "messages", query);
    const ids: string[] = [];
    for (const { id } of page?.messages ?? []) {
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);
      ids.push(id);
    }

    for (let index = 0; index < ids.length; index += HEADER_FETCH_CONCURRENCY) {
      const batch = await Promise.all(ids.slice(index, index + HEADER_FETCH_CONCURRENCY).map(
        (id) => getGmailMessageMetadata(accessToken, id, cutoffMs),
      ));
      for (const message of batch) if (message) messages.push(message);
    }

    const nextPage = page?.nextPageToken;
    if (!nextPage) break;
    if (seenPageTokens.has(nextPage)) {
      throw new GmailOAuthError("Gmail returned a repeated page token. Try again.");
    }
    seenPageTokens.add(nextPage);
    query.set("pageToken", nextPage);
  } while (true);

  return messages;
}
