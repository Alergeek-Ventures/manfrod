import { isAdmin, listUsers } from "@/lib/accounts.ts";
import { listHeaderTokens } from "@/lib/mcp/index.ts";
import { listSecretsFor } from "@/lib/secrets.ts";
import { requireUser } from "@/lib/web/session.ts";
import { SecretsClient, type SecretRow } from "./secrets-client.tsx";

export const dynamic = "force-dynamic";

export default async function SecretsPage() {
  const user = await requireUser();
  const names = new Map((await listUsers()).map((person) => [person.id, person.name || person.email || person.slackId]));
  const rows: SecretRow[] = (await listSecretsFor(user)).map((secret) => ({
    id: secret.id,
    name: secret.name,
    description: secret.description,
    scope: secret.scope,
    hosts: secret.allowedHosts,
    owner: secret.ownerUserId ? (names.get(secret.ownerUserId) ?? null) : null,
    mine: secret.ownerUserId === user.id,
    updatedAt: secret.updatedAt.toISOString(),
    mcpHeader: null,
  }));
  for (const token of await listHeaderTokens(user.id)) {
    rows.push({
      id: `mcp:${token.providerId}`,
      name: token.name,
      description: `Token for the ${token.name} MCP server. Change or remove it on the Integrations page.`,
      scope: "personal",
      hosts: [token.host],
      owner: null,
      mine: true,
      updatedAt: token.updatedAt.toISOString(),
      mcpHeader: token.header,
    });
  }
  return <SecretsClient rows={rows} admin={isAdmin(user)} />;
}
