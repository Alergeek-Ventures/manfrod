import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.ts";
import { logger } from "../log.ts";
import type { LResult } from "./client.ts";

const AUTHORIZE_URL = "https://linear.app/oauth/authorize";
const TOKEN_URL = "https://api.linear.app/oauth/token";
const REVOKE_URL = "https://api.linear.app/oauth/revoke";
const SCOPES = "read,write,issues:create,comments:create";
const log = logger("Linear.OAuth");

export const OAUTH_COOKIE = "manfrod_linear_oauth";

export interface LinearTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  scope: string | null;
}

export interface InstallIntent {
  projectId: string;
  slackUserId: string;
}

const INTENT_TTL_MS = 10 * 60 * 1000;

export const redirectUri = () => `${config.appUrl}/linear/callback`;

const sign = (payload: string) => createHmac("sha256", config.internalApiSecret).update(`linear-intent:${payload}`).digest("base64url");

export function installLink(intent: InstallIntent): string | null {
  if (!config.linearClientId) return null;
  const payload = Buffer.from(JSON.stringify({ ...intent, exp: Date.now() + INTENT_TTL_MS })).toString("base64url");
  return `${config.appUrl}/linear/connect?intent=${payload}.${sign(payload)}`;
}

export function readIntent(token: string | null | undefined, { allowExpired = false } = {}): InstallIntent | null {
  const [payload, signature] = (token ?? "").split(".");
  if (!payload || !signature) return null;
  const expected = Buffer.from(sign(payload));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as InstallIntent & { exp: number };
  if (!allowExpired && data.exp < Date.now()) return null;
  return { projectId: data.projectId, slackUserId: data.slackUserId };
}

export function authorizeUrl(state: string): string | null {
  if (!config.linearClientId) return null;
  const params = new URLSearchParams({
    client_id: config.linearClientId,
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPES,
    state,
    actor: "app",
    prompt: "consent",
  });
  return `${AUTHORIZE_URL}?${params}`;
}

async function postToken(form: Record<string, string>): Promise<LResult<LinearTokens>> {
  if (!config.linearClientId || !config.linearClientSecret) return { ok: false, error: "oauth_not_configured" };
  const body = new URLSearchParams({ ...form, client_id: config.linearClientId, client_secret: config.linearClientSecret });
  try {
    const response = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await response.json().catch(() => null)) as Record<string, any> | null;
    if (response.status !== 200 || !json?.access_token) {
      log.warn(`Linear.OAuth: token request failed: HTTP ${response.status} ${json?.error ?? ""}`);
      return {
        ok: false,
        error: response.status === 400 || response.status === 401 ? "invalid_grant" : `token_request_failed_${response.status}`,
      };
    }
    return {
      ok: true,
      value: {
        accessToken: json.access_token,
        refreshToken: json.refresh_token ?? null,
        expiresAt: json.expires_in ? new Date(Math.floor(Date.now() / 1000 + json.expires_in) * 1000) : null,
        scope: json.scope ?? null,
      },
    };
  } catch (error) {
    log.warn(`Linear.OAuth: transport error: ${(error as Error).message}`);
    return { ok: false, error: (error as Error).message };
  }
}

export const exchangeCode = (code: string) => postToken({ grant_type: "authorization_code", code, redirect_uri: redirectUri() });

export const refreshTokens = (refreshToken: string) => postToken({ grant_type: "refresh_token", refresh_token: refreshToken });

export async function revoke(accessToken: string): Promise<void> {
  await fetch(REVOKE_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10_000),
  }).catch((error: Error) => log.warn(`Linear.OAuth: revoke failed: ${error.message}`));
}
