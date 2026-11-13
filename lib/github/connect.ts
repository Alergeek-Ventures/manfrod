import { randomBytes, timingSafeEqual } from "node:crypto";
import type { GithubAccount } from "../db/schema.ts";

export const OAUTH_COOKIE_MAX_AGE = 600;

export interface OauthCookie {
  state: string;
  userId: string;
}

export interface CallbackPlan {
  linkUserId: string | null;
  code: string | null;
  installationId: number | null;
  error: string | null;
}

export type AccountStatus = "connected" | "expired" | "not_connected";

export const newOauthCookie = (userId: string): OauthCookie => ({ state: randomBytes(24).toString("base64url"), userId });

export const encodeOauthCookie = (cookie: OauthCookie) => JSON.stringify(cookie);

export function parseOauthCookie(raw: string | undefined): OauthCookie | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<OauthCookie>;
    return typeof value.state === "string" && value.state !== "" && typeof value.userId === "string" && value.userId !== ""
      ? { state: value.state, userId: value.userId }
      : null;
  } catch {
    return null;
  }
}

export function parseInstallationId(value: string | null): number | null {
  if (!value || !/^\d{1,15}$/.test(value)) return null;
  const id = Number(value);
  return id > 0 ? id : null;
}

const sameState = (expected: string, given: string | null) => {
  if (!given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
};

export function planCallback(params: URLSearchParams, rawCookie: string | undefined, sessionUserId: string | null): CallbackPlan {
  const installationId = parseInstallationId(params.get("installation_id"));
  if (params.get("error")) return { linkUserId: null, code: null, installationId, error: "GitHub authorization was cancelled." };
  const cookie = parseOauthCookie(rawCookie);
  const verified = cookie !== null && sameState(cookie.state, params.get("state")) && sessionUserId === cookie.userId;
  const code = params.get("code");
  if (verified && code) return { linkUserId: cookie.userId, code, installationId, error: null };
  if (installationId) return { linkUserId: null, code: null, installationId, error: null };
  return {
    linkUserId: null,
    code: null,
    installationId: null,
    error: verified
      ? "GitHub did not return an authorization code. Try again."
      : "Your GitHub sign-in expired or was started in another browser. Try again.",
  };
}

export function accountStatus(account: Pick<GithubAccount, "status" | "refreshExpiresAt"> | null, now = new Date()): AccountStatus {
  if (!account) return "not_connected";
  if (account.status !== "connected") return "expired";
  return account.refreshExpiresAt && account.refreshExpiresAt <= now ? "expired" : "connected";
}
