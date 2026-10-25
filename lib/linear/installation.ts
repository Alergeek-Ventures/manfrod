import { asc, eq, inArray } from "drizzle-orm";
import { db, tables } from "../db/index.ts";
import type { LinearInstallation } from "../db/schema.ts";
import { logger } from "../log.ts";
import { decrypt, encrypt } from "../vault.ts";
import type { LResult } from "./client.ts";
import { type LinearTokens, refreshTokens, revoke } from "./oauth.ts";

const { linearInstallations, projectLinearConnections } = tables;
const log = logger("Linear.Installation");
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export async function listInstallations(): Promise<LinearInstallation[]> {
  return db.select().from(linearInstallations).orderBy(asc(linearInstallations.organizationName));
}

export async function saveInstallation(
  tokens: LinearTokens,
  organization: { id: string; name: string; appUserId: string },
  teamIds: string[],
  userId: string | null,
): Promise<{ installation: LinearInstallation; linked: number }> {
  const values = {
    organizationId: organization.id,
    organizationName: organization.name,
    appUserId: organization.appUserId,
    accessToken: encrypt(tokens.accessToken),
    refreshToken: tokens.refreshToken ? encrypt(tokens.refreshToken) : null,
    expiresAt: tokens.expiresAt,
    scope: tokens.scope,
    status: "connected",
    installedByUserId: userId,
  };
  return db.transaction(async (tx) => {
    const [installation] = await tx
      .insert(linearInstallations)
      .values(values)
      .onConflictDoUpdate({ target: linearInstallations.organizationId, set: values })
      .returning();
    const linked =
      teamIds.length === 0
        ? []
        : await tx
            .update(projectLinearConnections)
            .set({ installationId: installation.id, apiKey: null })
            .where(inArray(projectLinearConnections.linearTeamId, teamIds))
            .returning({ id: projectLinearConnections.id });
    return { installation, linked: linked.length };
  });
}

export async function installationToken(installationId: string): Promise<LResult<string>> {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(linearInstallations).where(eq(linearInstallations.id, installationId)).for("update");
    if (!row) return { ok: false, error: "not_installed" };
    if (row.status !== "connected") return { ok: false, error: "expired" };
    if (!row.expiresAt || row.expiresAt.getTime() - Date.now() > REFRESH_MARGIN_MS) return { ok: true, value: decrypt(row.accessToken) };
    if (!row.refreshToken) return { ok: true, value: decrypt(row.accessToken) };

    const tokens = await refreshTokens(decrypt(row.refreshToken));
    if (!tokens.ok) {
      if (tokens.error === "invalid_grant") {
        log.error(`Linear.Installation: refresh rejected for ${row.organizationName ?? row.organizationId}, marking expired`);
        await tx.update(linearInstallations).set({ status: "expired" }).where(eq(linearInstallations.id, row.id));
        return { ok: false, error: "expired" };
      }
      return tokens;
    }
    await tx
      .update(linearInstallations)
      .set({
        accessToken: encrypt(tokens.value.accessToken),
        refreshToken: encrypt(tokens.value.refreshToken ?? decrypt(row.refreshToken)),
        expiresAt: tokens.value.expiresAt,
        scope: tokens.value.scope ?? row.scope,
      })
      .where(eq(linearInstallations.id, row.id));
    return { ok: true, value: tokens.value.accessToken };
  });
}

export async function uninstall(installationId: string): Promise<boolean> {
  const [row] = await db.delete(linearInstallations).where(eq(linearInstallations.id, installationId)).returning();
  if (!row) return false;
  await revoke(decrypt(row.accessToken));
  return true;
}
