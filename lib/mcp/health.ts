import { config } from "../config.ts";
import { EVENTS, sendEvent, type McpTokenUnavailableData } from "../inngest/client.ts";
import { logger } from "../log.ts";
import { deliverProactive, sendProactive } from "../proactive.ts";
import {
  getConnection,
  getProviderForUser,
  invalidateTools,
  isTokenRejected,
  markExpired,
  markNotified,
  refreshToken,
  type Provider,
} from "./index.ts";

const log = logger("Mcp.Health");

export const TOKEN_RETRY_DELAYS = ["30s", "2m", "10m"] as const;

export type TokenFailure = "token_rejected" | "token_unavailable";

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

export async function expireConnection(userId: string, provider: Provider, reason: string): Promise<void> {
  invalidateTools(userId, provider.id);
  const connection = await getConnection(userId, provider.id);
  if (!connection) return;
  if (connection.status === "expired" && connection.notifiedExpiredAt !== null) return;
  log.info(`Mcp.Health: ${provider.id}/${userId} expired (${reason}), notifying`);
  const updated = await markExpired(connection);
  await notifyExpired(userId, provider);
  await markNotified(updated);
}

export async function handleTokenFailure(userId: string, provider: Provider, error: string): Promise<TokenFailure> {
  invalidateTools(userId, provider.id);
  if (isTokenRejected(error)) {
    await expireConnection(userId, provider, error);
    return "token_rejected";
  }
  log.warn(`Mcp.Health: ${provider.id}/${userId} token refresh failed (${error}), retrying later`);
  await sendEvent(EVENTS.mcpTokenUnavailable, { userId, providerId: provider.id } satisfies McpTokenUnavailableData);
  return "token_unavailable";
}

export async function retryToken(userId: string, providerId: string): Promise<"ok" | "gone" | "expired" | "unavailable"> {
  const provider = await getProviderForUser(userId, providerId);
  const connection = await getConnection(userId, providerId);
  if (!provider || provider.authHeader || !connection || connection.status === "disconnected") return "gone";
  const token = await refreshToken(connection);
  if (token.ok) return "ok";
  if (!isTokenRejected(token.error)) {
    log.warn(`Mcp.Health: ${providerId}/${userId} token refresh still failing (${token.error})`);
    return "unavailable";
  }
  await expireConnection(userId, provider, token.error);
  return "expired";
}

export async function giveUpOnToken(userId: string, providerId: string): Promise<void> {
  const provider = await getProviderForUser(userId, providerId);
  if (provider) await expireConnection(userId, provider, `refresh still failing after ${TOKEN_RETRY_DELAYS.length} retries`);
}
