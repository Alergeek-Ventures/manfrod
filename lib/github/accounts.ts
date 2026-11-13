import { eq } from "drizzle-orm";
import { db, tables } from "../db/index.ts";
import type { GithubAccount } from "../db/schema.ts";
import { logger } from "../log.ts";
import { decrypt, encrypt } from "../vault.ts";
import { github } from "./api.ts";
import { type GithubTokens, refreshTokens, revokeGrant } from "./oauth.ts";

const { githubAccounts } = tables;
const log = logger("Github.Accounts");
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export type UserTokenResult = { ok: true; value: string } | { ok: false; error: "not_connected" | "expired" | string };

export async function getAccount(userId: string): Promise<GithubAccount | null> {
  const [row] = await db.select().from(githubAccounts).where(eq(githubAccounts.userId, userId)).limit(1);
  return row ?? null;
}

export async function listAccounts(): Promise<GithubAccount[]> {
  return db.select().from(githubAccounts).where(eq(githubAccounts.status, "connected"));
}

export async function connectAccount(userId: string, tokens: GithubTokens): Promise<GithubAccount> {
  const profile = await github<{ id: number; login: string; email: string | null }>(tokens.accessToken, "GET", "/user");
  if (!profile) throw new Error("GitHub did not return the authorized user.");
  const emails = (await github<{ email: string; verified: boolean }[]>(tokens.accessToken, "GET", "/user/emails").catch(() => null)) ?? [];
  const verified = emails.filter((entry) => entry.verified).map((entry) => entry.email.toLowerCase());
  const values = {
    githubUserId: profile.id,
    login: profile.login,
    emails: [
      ...new Set([
        ...verified,
        ...(profile.email ? [profile.email.toLowerCase()] : []),
        `${profile.id}+${profile.login}@users.noreply.github.com`.toLowerCase(),
        `${profile.login}@users.noreply.github.com`.toLowerCase(),
      ]),
    ],
    accessToken: encrypt(tokens.accessToken),
    refreshToken: tokens.refreshToken ? encrypt(tokens.refreshToken) : null,
    expiresAt: tokens.expiresAt,
    refreshExpiresAt: tokens.refreshExpiresAt,
    status: "connected",
    updatedAt: new Date(),
  };
  return db.transaction(async (tx) => {
    await tx.delete(githubAccounts).where(eq(githubAccounts.githubUserId, profile.id));
    const [row] = await tx
      .insert(githubAccounts)
      .values({ userId, ...values })
      .onConflictDoUpdate({ target: githubAccounts.userId, set: values })
      .returning();
    return row;
  });
}

export async function disconnectAccount(userId: string): Promise<boolean> {
  const [row] = await db.delete(githubAccounts).where(eq(githubAccounts.userId, userId)).returning();
  if (!row) return false;
  await revokeGrant(decrypt(row.accessToken));
  return true;
}

export async function userToken(userId: string): Promise<UserTokenResult> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(githubAccounts).where(eq(githubAccounts.userId, userId)).for("update");
    if (!row) return { ok: false, error: "not_connected" };
    if (row.status !== "connected") return { ok: false, error: "expired" };
    if (!row.expiresAt || row.expiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS || !row.refreshToken) {
      return { ok: true, value: decrypt(row.accessToken) };
    }
    const tokens = await refreshTokens(decrypt(row.refreshToken)).catch((error: unknown): { ok: false; error: string } => ({
      ok: false,
      error: `refresh_failed: ${(error as Error).message}`,
    }));
    if (!tokens.ok) {
      if (tokens.error === "invalid_grant") {
        log.warn(`Github.Accounts: refresh rejected for ${row.login}, marking expired`);
        await tx.update(githubAccounts).set({ status: "expired", updatedAt: new Date() }).where(eq(githubAccounts.userId, userId));
        return { ok: false, error: "expired" };
      }
      return tokens;
    }
    await tx
      .update(githubAccounts)
      .set({
        accessToken: encrypt(tokens.value.accessToken),
        refreshToken: tokens.value.refreshToken ? encrypt(tokens.value.refreshToken) : row.refreshToken,
        expiresAt: tokens.value.expiresAt,
        refreshExpiresAt: tokens.value.refreshExpiresAt ?? row.refreshExpiresAt,
        updatedAt: new Date(),
      })
      .where(eq(githubAccounts.userId, userId));
    return { ok: true, value: tokens.value.accessToken };
  });
}
