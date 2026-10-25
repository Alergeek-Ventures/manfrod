import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { db, tables } from "../db/index.ts";
import type { McpConnection, McpOauthClient } from "../db/schema.ts";
import { logger } from "../log.ts";
import { discoverLogo, discoverName, listTools, type McpResult, type RemoteTool } from "./client.ts";

const { mcpConnections, mcpCustomProviders, mcpOauthClients } = tables;
const log = logger("Mcp");

export interface Provider {
  id: string;
  name: string;
  mcpUrl: string;
  mock: boolean;
  logoUrl: string | null;
  custom: boolean;
  scope: string | null;
}

export function builtinProviders(): Provider[] {
  return [
    {
      id: "firmowid",
      name: "Firmowid",
      mcpUrl: "https://firmowid.pl/mcp",
      mock: false,
      logoUrl: null,
      custom: false,
      scope: "mcp",
    },
  ];
}

export async function listCustomProviders(userId: string) {
  return db
    .select()
    .from(mcpCustomProviders)
    .where(eq(mcpCustomProviders.userId, userId))
    .orderBy(asc(mcpCustomProviders.insertedAt));
}

export async function providersForUser(userId: string): Promise<Provider[]> {
  const custom = await listCustomProviders(userId);
  return [
    ...builtinProviders(),
    ...custom.map((provider) => ({
      id: provider.id,
      name: provider.name ?? provider.url,
      mcpUrl: provider.url,
      mock: false,
      logoUrl: provider.logoUrl,
      custom: true,
      scope: provider.scope,
    })),
  ];
}

export async function getProviderForUser(userId: string, id: string): Promise<Provider | null> {
  return (await providersForUser(userId)).find((provider) => provider.id === id) ?? null;
}

export async function createCustomProvider(userId: string, url: string, name: string | null = null, scope: string | null = null) {
  if (!/^https?:\/\//.test(url)) throw new Error("url: must be a valid http(s) URL");
  const presentName = name && name !== "" ? name : null;
  const [provider] = await db
    .insert(mcpCustomProviders)
    .values({ userId, url, name: presentName, scope: scope && scope !== "" ? scope : null })
    .returning();
  const [discoveredName, logoUrl] = await Promise.all([discoverName(url), discoverLogo(url)]);
  const updates: Record<string, string> = {};
  const resolvedName = presentName ?? discoveredName;
  if (resolvedName) updates.name = resolvedName;
  if (logoUrl) updates.logoUrl = logoUrl;
  if (Object.keys(updates).length === 0) return provider;
  const [updated] = await db
    .update(mcpCustomProviders)
    .set(updates)
    .where(eq(mcpCustomProviders.id, provider.id))
    .returning();
  return updated;
}

export async function deleteCustomProvider(userId: string, id: string): Promise<boolean> {
  const [provider] = await db
    .select()
    .from(mcpCustomProviders)
    .where(and(eq(mcpCustomProviders.userId, userId), eq(mcpCustomProviders.id, id)))
    .limit(1);
  if (!provider) return false;
  await disconnect(userId, id);
  await db.delete(mcpOauthClients).where(eq(mcpOauthClients.provider, id));
  await db.delete(mcpCustomProviders).where(eq(mcpCustomProviders.id, id));
  return true;
}

export async function listConnections(userId: string): Promise<Map<string, McpConnection>> {
  const rows = await db.select().from(mcpConnections).where(eq(mcpConnections.userId, userId));
  return new Map(rows.map((row) => [row.provider, row]));
}

export async function getConnection(userId: string, provider: string): Promise<McpConnection | null> {
  const [row] = await db
    .select()
    .from(mcpConnections)
    .where(and(eq(mcpConnections.userId, userId), eq(mcpConnections.provider, provider)))
    .limit(1);
  return row ?? null;
}

export async function listConnectionsForProvider(provider: string, status = "connected"): Promise<McpConnection[]> {
  return db
    .select()
    .from(mcpConnections)
    .where(and(eq(mcpConnections.provider, provider), eq(mcpConnections.status, status)));
}

export async function listAllConnectionsWithProvider(): Promise<{ connection: McpConnection; provider: Provider }[]> {
  const rows = await db
    .select()
    .from(mcpConnections)
    .where(inArray(mcpConnections.status, ["connected", "expired"]));
  const result: { connection: McpConnection; provider: Provider }[] = [];
  for (const connection of rows) {
    const provider = await getProviderForUser(connection.userId, connection.provider);
    if (provider) result.push({ connection, provider });
  }
  return result;
}

export type TokenAttrs = Partial<
  Pick<McpConnection, "accessToken" | "refreshToken" | "expiresAt" | "scope" | "status" | "notifiedExpiredAt">
>;

export async function saveTokens(userId: string, provider: string, attrs: TokenAttrs): Promise<McpConnection> {
  const values = { status: "connected", ...attrs };
  const existing = await getConnection(userId, provider);
  if (existing) {
    const [updated] = await db.update(mcpConnections).set(values).where(eq(mcpConnections.id, existing.id)).returning();
    return updated;
  }
  const [created] = await db.insert(mcpConnections).values({ userId, provider, ...values }).returning();
  return created;
}

export async function markExpired(connection: McpConnection): Promise<McpConnection> {
  if (connection.status === "expired") return connection;
  const [updated] = await db
    .update(mcpConnections)
    .set({ status: "expired" })
    .where(eq(mcpConnections.id, connection.id))
    .returning();
  return updated;
}

export async function markNotified(connection: McpConnection): Promise<void> {
  await db
    .update(mcpConnections)
    .set({ notifiedExpiredAt: new Date() })
    .where(eq(mcpConnections.id, connection.id));
}

export async function disconnect(userId: string, provider: string): Promise<void> {
  await db
    .delete(mcpConnections)
    .where(and(eq(mcpConnections.userId, userId), eq(mcpConnections.provider, provider)));
}

export async function ensureValidToken(connection: McpConnection): Promise<McpResult<string>> {
  if (connection.status === "disconnected") return { ok: false, error: "disconnected" };
  if (!connection.accessToken) return { ok: false, error: "no_token" };
  if (connection.expiresAt && connection.expiresAt.getTime() - Date.now() < 60_000) return refreshToken(connection);
  return { ok: true, value: connection.accessToken };
}

export async function refreshToken(connection: McpConnection): Promise<McpResult<string>> {
  if (!connection.refreshToken) return { ok: false, error: "no_refresh_token" };
  const tokens = await refresh(connection.provider, connection.refreshToken);
  if (!tokens.ok) return tokens;
  const updated = await saveTokens(connection.userId, connection.provider, {
    accessToken: tokens.value.accessToken,
    refreshToken: tokens.value.refreshToken ?? connection.refreshToken,
    expiresAt: tokens.value.expiresIn ? new Date(Date.now() + tokens.value.expiresIn * 1000) : null,
    status: "connected",
    notifiedExpiredAt: null,
  });
  return { ok: true, value: updated.accessToken! };
}

export async function getOauthClient(provider: string): Promise<McpOauthClient | null> {
  const [client] = await db.select().from(mcpOauthClients).where(eq(mcpOauthClients.provider, provider)).limit(1);
  return client ?? null;
}

interface Metadata {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint: string | null;
}

async function fetchMetadata(url: string): Promise<Metadata | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (response.status !== 200) return null;
    const body = (await response.json()) as Record<string, string>;
    if (!body.authorization_endpoint) return null;
    return {
      authorizationEndpoint: body.authorization_endpoint,
      tokenEndpoint: body.token_endpoint,
      registrationEndpoint: body.registration_endpoint ?? null,
    };
  } catch {
    return null;
  }
}

export async function discoverMetadata(mcpUrl: string): Promise<Metadata | null> {
  const origin = new URL(mcpUrl).origin;
  return (
    (await fetchMetadata(`${origin}/.well-known/oauth-authorization-server`)) ??
    (await fetchMetadata(`${origin}/.well-known/openid-configuration`))
  );
}

async function ensureClient(provider: string, mcpUrl: string, redirectUri: string): Promise<McpResult<McpOauthClient>> {
  const existing = await getOauthClient(provider);
  if (existing) return { ok: true, value: existing };

  const metadata = await discoverMetadata(mcpUrl);
  if (!metadata) return { ok: false, error: "discovery_failed" };
  if (!metadata.registrationEndpoint) return { ok: false, error: "no_dynamic_registration" };

  const response = await fetch(metadata.registrationEndpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Manfrod",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch((error: Error) => error);

  if (response instanceof Error) return { ok: false, error: response.message };
  if (response.status !== 200 && response.status !== 201) {
    log.error(`Mcp.OAuth: client registration rejected for ${provider}: HTTP ${response.status}`);
    return { ok: false, error: `registration_rejected_${response.status}` };
  }
  const body = (await response.json()) as Record<string, string>;
  const [client] = await db
    .insert(mcpOauthClients)
    .values({
      provider,
      clientId: body.client_id,
      clientSecret: body.client_secret ?? null,
      authorizationEndpoint: metadata.authorizationEndpoint,
      tokenEndpoint: metadata.tokenEndpoint,
      registrationEndpoint: metadata.registrationEndpoint,
    })
    .onConflictDoNothing({ target: mcpOauthClients.provider })
    .returning();
  return { ok: true, value: client ?? (await getOauthClient(provider))! };
}

export async function authorizeUrl(
  provider: string,
  mcpUrl: string,
  redirectUri: string,
  scope: string | null,
): Promise<McpResult<{ url: string; codeVerifier: string; state: string }>> {
  const client = await ensureClient(provider, mcpUrl, redirectUri);
  if (!client.ok) return client;

  const codeVerifier = randomBytes(64).toString("base64url");
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
  const state = randomBytes(24).toString("base64url");
  const params = new URLSearchParams({
    response_type: "code",
    client_id: client.value.clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
    state,
  });
  if (scope) params.set("scope", scope);
  return { ok: true, value: { url: `${client.value.authorizationEndpoint}?${params}`, codeVerifier, state } };
}

export interface Tokens {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
  scope: string | null;
}

async function postToken(client: McpOauthClient, form: Record<string, string>): Promise<McpResult<Tokens>> {
  const body = new URLSearchParams(form);
  if (client.clientSecret) body.set("client_secret", client.clientSecret);
  const response = await fetch(client.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(10_000),
  }).catch((error: Error) => error);
  if (response instanceof Error) return { ok: false, error: response.message };
  if (response.status !== 200) {
    log.error(`Mcp.OAuth: token request failed: HTTP ${response.status}`);
    return { ok: false, error: `token_request_failed_${response.status}` };
  }
  const json = (await response.json()) as Record<string, any>;
  return {
    ok: true,
    value: {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? null,
      expiresIn: json.expires_in ?? null,
      scope: json.scope ?? null,
    },
  };
}

export async function exchangeCode(provider: string, code: string, codeVerifier: string, redirectUri: string) {
  const client = await getOauthClient(provider);
  if (!client) return { ok: false as const, error: "client_not_registered" };
  return postToken(client, {
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: client.clientId,
    code_verifier: codeVerifier,
  });
}

export async function refresh(provider: string, token: string) {
  const client = await getOauthClient(provider);
  if (!client) return { ok: false as const, error: "client_not_registered" };
  return postToken(client, { grant_type: "refresh_token", refresh_token: token, client_id: client.clientId });
}

const toolCache = new Map<string, { tools: RemoteTool[]; expiresAt: number }>();
const TOOL_CACHE_TTL_MS = 5 * 60 * 1000;

export async function cachedTools(userId: string, provider: Provider, accessToken: string): Promise<McpResult<RemoteTool[]>> {
  const key = `${userId}:${provider.id}`;
  const cached = toolCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return { ok: true, value: cached.tools };
  const result = await listTools(provider.mcpUrl, accessToken);
  if (result.ok) toolCache.set(key, { tools: result.value, expiresAt: Date.now() + TOOL_CACHE_TTL_MS });
  return result;
}

export function invalidateTools(userId: string, providerId: string): void {
  toolCache.delete(`${userId}:${providerId}`);
}
