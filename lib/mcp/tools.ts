import { config } from "../config.ts";
import { logger } from "../log.ts";
import type { ChannelAudience } from "../memory/access.ts";
import { deliverProactive, sendProactive } from "../proactive.ts";
import { callTool, formatResult } from "./client.ts";
import {
  cachedTools,
  ensureValidToken,
  getConnection,
  getProviderForUser,
  invalidateTools,
  markExpired,
  markNotified,
  providersForUser,
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

export function expiredConnectionPrompt(providerName: string): string {
  return `Tell the user that their ${providerName} connection expired and that they can reconnect it at ${config.appUrl}/integrations so you can keep using it. Write only about this, in the user's language, and do not bring up notes, reservations or anything else.`;
}

async function notifyExpired(userId: string, provider: Provider) {
  const text = expiredConnectionPrompt(provider.name);
  try {
    await deliverProactive(userId, text);
  } catch {
    await sendProactive(userId, text);
  }
}

async function handleUnauthorized(userId: string, provider: Provider) {
  invalidateTools(userId, provider.id);
  const connection = await getConnection(userId, provider.id);
  if (!connection) return;
  const wasConnected = connection.status !== "expired";
  const updated = await markExpired(connection);
  if (wasConnected || updated.notifiedExpiredAt === null) {
    await notifyExpired(userId, provider);
    await markNotified(updated);
  }
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
    const token = await ensureValidToken(connection);
    if (!token.ok) {
      log.debug(`Tools.Mcp: no valid token for ${provider.id}/${userId}: ${token.error}`);
      continue;
    }
    const remote = await cachedTools(userId, provider, token.value);
    if (!remote.ok) {
      if (remote.error === "unauthorized") await handleUnauthorized(userId, provider);
      else log.warn(`Tools.Mcp: failed to list tools for ${provider.id}: ${remote.error}`);
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
  const token = await ensureValidToken(connection);
  if (!token.ok) {
    await handleUnauthorized(userId, provider);
    return `ERROR: ${provider.name} connection expired. The user needs to reconnect it at the web app.`;
  }
  const result = await callTool(provider.mcpUrl, token.value, remoteName, args ?? {});
  if (result.ok) return formatResult(result.value);
  if (result.error === "unauthorized") {
    await handleUnauthorized(userId, provider);
    return `ERROR: ${provider.name} connection expired. The user needs to reconnect it at the web app.`;
  }
  return `${provider.name} MCP call failed: ${result.error}`;
}
