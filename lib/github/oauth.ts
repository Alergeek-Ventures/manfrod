import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.ts";

export interface GithubTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
  refreshExpiresAt: Date | null;
}

export type TokenResult = { ok: true; value: GithubTokens } | { ok: false; error: string };

export const OAUTH_COOKIE = "manfrod_github_oauth";

export const callbackUrl = () => `${config.appUrl}/github/callback`;

export function authorizeUrl(state: string): string | null {
  if (!config.githubAppClientId) return null;
  const params = new URLSearchParams({ client_id: config.githubAppClientId, redirect_uri: callbackUrl(), state });
  return `https://github.com/login/oauth/authorize?${params}`;
}

const inSeconds = (seconds: unknown) => (typeof seconds === "number" && seconds > 0 ? new Date(Date.now() + seconds * 1000) : null);

async function postToken(form: Record<string, string>): Promise<TokenResult> {
  if (!config.githubAppClientId || !config.githubAppClientSecret) return { ok: false, error: "oauth_not_configured" };
  const response = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ ...form, client_id: config.githubAppClientId, client_secret: config.githubAppClientSecret }),
    signal: AbortSignal.timeout(15_000),
  });
  const json = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok || typeof json?.access_token !== "string") {
    const error = typeof json?.error === "string" ? json.error : `token_request_failed_${response.status}`;
    return { ok: false, error: error === "bad_verification_code" || error === "bad_refresh_token" ? "invalid_grant" : error };
  }
  return {
    ok: true,
    value: {
      accessToken: json.access_token,
      refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : null,
      expiresAt: inSeconds(json.expires_in),
      refreshExpiresAt: inSeconds(json.refresh_token_expires_in),
    },
  };
}

export const exchangeCode = (code: string) => postToken({ code, redirect_uri: callbackUrl() });

export const refreshTokens = (refreshToken: string) => postToken({ grant_type: "refresh_token", refresh_token: refreshToken });

export async function revokeGrant(accessToken: string): Promise<void> {
  if (!config.githubAppClientId || !config.githubAppClientSecret) return;
  const basic = Buffer.from(`${config.githubAppClientId}:${config.githubAppClientSecret}`).toString("base64");
  await fetch(`https://api.github.com/applications/${config.githubAppClientId}/grant`, {
    method: "DELETE",
    headers: { accept: "application/vnd.github+json", authorization: `Basic ${basic}`, "content-type": "application/json" },
    body: JSON.stringify({ access_token: accessToken }),
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined);
}

export function verifyWebhookSignature(secret: string, body: string, header: string | null): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}
