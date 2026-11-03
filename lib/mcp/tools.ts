import type { McpConnection } from "../db/schema.ts";
import { logger } from "../log.ts";
import type { ChannelAudience } from "../memory/access.ts";
import { callTool, formatResult, type McpAuth, type McpResult } from "./client.ts";
import { handleTokenFailure } from "./health.ts";
import {
  cachedTools,
  connectionHeaderAuth,
  ensureValidToken,
  getConnection,
  getProviderForUser,
  invalidateTools,
  providersForUser,
  refreshToken,
  type Provider,
} from "./index.ts";

const log = logger("Tools.Mcp");

export interface McpToolEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  providerId: string;
  remoteName: string;
  host: string | null;
}

export function toolPrefix(provider: Pick<Provider, "id" | "custom">): string {
  return provider.custom ? `c${provider.id.replace(/-/g, "").slice(0, 8)}` : provider.id;
}

function toolName(prefix: string, remoteName: string): string {
  return `${prefix}__${remoteName.replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 64);
}

async function withToken<T>(
  provider: Provider,
  connection: McpConnection,
  run: (auth: McpAuth) => Promise<McpResult<T>>,
): Promise<McpResult<T>> {
  const { userId } = connection;
  if (provider.authHeader) {
    const auth = connectionHeaderAuth(provider, connection);
    if (!auth) return { ok: false, error: await handleTokenFailure(userId, provider, "no_token") };
    const result = await run(auth);
    if (result.ok || result.error !== "unauthorized") return result;
    return { ok: false, error: await handleTokenFailure(userId, provider, "rejected") };
  }
  const token = await ensureValidToken(connection);
  if (!token.ok) return { ok: false, error: await handleTokenFailure(userId, provider, token.error) };
  const first = await run(token.value);
  if (first.ok || first.error !== "unauthorized") return first;
  invalidateTools(userId, provider.id);
  const refreshed = await refreshToken(connection);
  if (!refreshed.ok) return { ok: false, error: await handleTokenFailure(userId, provider, refreshed.error) };
  const second = await run(refreshed.value);
  if (second.ok || second.error !== "unauthorized") return second;
  return { ok: false, error: await handleTokenFailure(userId, provider, "rejected") };
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

export async function listUserMcpTools(userId: string, audience: ChannelAudience): Promise<McpToolEntry[]> {
  const entries: McpToolEntry[] = [];
  for (const provider of await providersForUser(userId)) {
    if (provider.mock || !provider.availability.includes(audience)) continue;
    const connection = await getConnection(userId, provider.id);
    if (!connection || connection.status === "disconnected") continue;
    const remote = await withToken(provider, connection, (auth) => cachedTools(userId, provider, auth));
    if (!remote.ok) {
      log.warn(`Tools.Mcp: failed to list tools for ${provider.id}: ${remote.error}`);
      continue;
    }
    const prefix = toolPrefix(provider);
    for (const tool of remote.value) {
      entries.push({
        name: toolName(prefix, tool.name),
        description: `[${provider.name} MCP] ${tool.description ?? tool.name}`,
        inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
        providerId: provider.id,
        remoteName: tool.name,
        host: hostOf(provider.mcpUrl),
      });
    }
  }
  return entries;
}

export async function callUserMcpTool(userId: string, providerId: string, remoteName: string, args: unknown): Promise<string> {
  const provider = await getProviderForUser(userId, providerId);
  if (!provider) return `MCP provider not found: ${providerId}`;
  const connection = await getConnection(userId, providerId);
  if (!connection) return `ERROR: ${provider.name} is not connected.`;
  const result = await withToken(provider, connection, (auth) => callTool(provider.mcpUrl, auth, remoteName, args ?? {}));
  if (result.ok) return formatResult(result.value);
  if (result.error === "token_rejected")
    return `ERROR: ${provider.name} connection expired. The user needs to reconnect it at the web app.`;
  if (result.error === "token_unavailable")
    return `ERROR: ${provider.name} sign-in is temporarily unavailable. Try again in a few minutes.`;
  return `${provider.name} MCP call failed: ${result.error}`;
}
