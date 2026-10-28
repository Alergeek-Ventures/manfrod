import { and, asc, eq, isNull, or } from "drizzle-orm";
import { isAdmin } from "./accounts.ts";
import { db } from "./db/index.ts";
import { agentSecrets, type User } from "./db/schema.ts";
import { emit } from "./events/index.ts";
import { decrypt, encrypt } from "./vault.ts";

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
const HOST_PATTERN = /^(\*\.)?([a-z0-9-]+\.)+[a-z]{2,}$/;
const PLACEHOLDER = /\{\{\s*([A-Z][A-Z0-9_]{1,63})\s*\}\}/g;
const CACHE_TTL_MS = 30_000;
const MIN_REDACT_LENGTH = 4;

export type SecretScope = "company" | "personal";

export interface SecretSummary {
  id: string;
  name: string;
  description: string | null;
  scope: SecretScope;
  ownerUserId: string | null;
  allowedHosts: string[];
  updatedAt: Date;
  updatedByUserId: string | null;
}

export interface UsableSecret {
  value: string;
  scope: SecretScope;
  allowedHosts: string[];
}

interface StoredSecret extends UsableSecret {
  name: string;
  ownerUserId: string | null;
}

let cache: { secrets: StoredSecret[]; loadedAt: number } | null = null;

export function placeholder(name: string): string {
  return `{{ ${name} }}`;
}

export function normalizeHosts(hosts: string[]): string[] {
  const normalized = [
    ...new Set(
      hosts.map((host) =>
        host
          .trim()
          .toLowerCase()
          .replace(/^https?:\/\//, "")
          .replace(/\/.*$/, ""),
      ),
    ),
  ];
  const invalid = normalized.filter((host) => host !== "" && !HOST_PATTERN.test(host));
  if (invalid.length > 0) throw new Error(`Invalid host(s): ${invalid.join(", ")}. Use e.g. api.github.com or *.example.com.`);
  return normalized.filter((host) => host !== "");
}

export function hostAllowed(host: string, allowedHosts: string[]): boolean {
  const target = host.toLowerCase();
  return allowedHosts.some((allowed) => (allowed.startsWith("*.") ? target.endsWith(allowed.slice(1)) : target === allowed));
}

const summaryColumns = {
  id: agentSecrets.id,
  name: agentSecrets.name,
  description: agentSecrets.description,
  scope: agentSecrets.scope,
  ownerUserId: agentSecrets.ownerUserId,
  allowedHosts: agentSecrets.allowedHosts,
  updatedAt: agentSecrets.updatedAt,
  updatedByUserId: agentSecrets.updatedByUserId,
};

export async function listSecretsFor(viewer: User): Promise<SecretSummary[]> {
  const rows = await db
    .select(summaryColumns)
    .from(agentSecrets)
    .where(isAdmin(viewer) ? undefined : or(eq(agentSecrets.scope, "company"), eq(agentSecrets.ownerUserId, viewer.id)))
    .orderBy(asc(agentSecrets.name));
  return rows as SecretSummary[];
}

export interface SecretInput {
  name: string;
  value: string | null;
  description: string | null;
  scope: SecretScope;
  allowedHosts: string[];
}

export async function saveSecret(actor: User, input: SecretInput): Promise<void> {
  if (!SECRET_NAME.test(input.name)) throw new Error("Name must be UPPER_SNAKE_CASE (A-Z, 0-9, _), 2-64 characters.");
  if (input.scope === "company" && !isAdmin(actor)) throw new Error("Only admins can add company secrets.");
  const allowedHosts = normalizeHosts(input.allowedHosts);
  const ownerUserId = input.scope === "personal" ? actor.id : null;
  const match = and(
    eq(agentSecrets.name, input.name),
    eq(agentSecrets.scope, input.scope),
    ownerUserId ? eq(agentSecrets.ownerUserId, ownerUserId) : isNull(agentSecrets.ownerUserId),
  );
  const [existing] = await db.select({ id: agentSecrets.id }).from(agentSecrets).where(match).limit(1);
  const fields = { description: input.description, allowedHosts, updatedByUserId: actor.id, updatedAt: new Date() };
  if (existing) {
    await db
      .update(agentSecrets)
      .set(input.value ? { ...fields, value: encrypt(input.value) } : fields)
      .where(eq(agentSecrets.id, existing.id));
  } else {
    if (!input.value) throw new Error("Value can't be blank.");
    await db.insert(agentSecrets).values({ ...fields, name: input.name, scope: input.scope, ownerUserId, value: encrypt(input.value) });
  }
  cache = null;
  emit("secret_updated", { userId: actor.id, source: "admin", meta: { name: input.name, scope: input.scope } });
}

export async function deleteSecret(actor: User, id: string): Promise<boolean> {
  const [row] = await db.select(summaryColumns).from(agentSecrets).where(eq(agentSecrets.id, id)).limit(1);
  if (!row) return false;
  const allowed = isAdmin(actor) || (row.scope === "personal" && row.ownerUserId === actor.id);
  if (!allowed) throw new Error("You can only delete your own secrets.");
  await db.delete(agentSecrets).where(eq(agentSecrets.id, id));
  cache = null;
  emit("secret_deleted", { userId: actor.id, source: "admin", meta: { name: row.name, scope: row.scope } });
  return true;
}

async function storedSecrets(): Promise<StoredSecret[]> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache.secrets;
  const rows = await db.select().from(agentSecrets);
  const secrets = rows.map((row) => ({
    name: row.name,
    value: decrypt(row.value),
    scope: row.scope as SecretScope,
    ownerUserId: row.ownerUserId,
    allowedHosts: row.allowedHosts,
  }));
  cache = { secrets, loadedAt: Date.now() };
  return secrets;
}

export function usableBy(secrets: StoredSecret[], userId: string | null): Map<string, UsableSecret> {
  const usable = new Map<string, UsableSecret>();
  for (const secret of secrets) if (secret.scope === "company") usable.set(secret.name, secret);
  for (const secret of secrets) if (secret.scope === "personal" && userId && secret.ownerUserId === userId) usable.set(secret.name, secret);
  return usable;
}

export async function usableSecrets(userId: string | null): Promise<Map<string, UsableSecret>> {
  return usableBy(await storedSecrets(), userId);
}

function mapStrings(value: unknown, fn: (text: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn));
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, mapStrings(inner, fn)]));
  }
  return value;
}

export class SecretUseError extends Error {}

export function substituteWith<T>(
  input: T,
  secrets: Map<string, UsableSecret>,
  host: string,
): { value: T; used: string[]; unknown: string[]; blocked: string[] } {
  const used = new Set<string>();
  const unknown = new Set<string>();
  const blocked = new Set<string>();
  const value = mapStrings(input, (text) =>
    text.replace(PLACEHOLDER, (match, name: string) => {
      const secret = secrets.get(name);
      if (!secret) {
        unknown.add(name);
        return match;
      }
      if (!hostAllowed(host, secret.allowedHosts)) {
        blocked.add(name);
        return match;
      }
      used.add(name);
      return secret.value;
    }),
  ) as T;
  return { value, used: [...used], unknown: [...unknown], blocked: [...blocked] };
}

export function redactWith<T>(output: T, secrets: Map<string, UsableSecret>): T {
  const entries = [...secrets.entries()]
    .filter(([, secret]) => secret.value.length >= MIN_REDACT_LENGTH)
    .sort((a, b) => b[1].value.length - a[1].value.length);
  if (entries.length === 0) return output;
  return mapStrings(output, (text) => entries.reduce((acc, [name, secret]) => acc.split(secret.value).join(placeholder(name)), text)) as T;
}

export function hasPlaceholder(input: unknown): boolean {
  let found = false;
  mapStrings(input, (text) => {
    if (new RegExp(PLACEHOLDER.source).test(text)) found = true;
    return text;
  });
  return found;
}

export interface SecretUse {
  toolName: string;
  userId?: string | null;
  sessionKey?: string | null;
  keepPlaceholders?: boolean;
  destinationHost?: string | null;
}

export async function runWithSecrets<I, R>(use: SecretUse, input: I, execute: (resolved: I) => Promise<R>): Promise<R> {
  const secrets = await usableSecrets(use.userId ?? null);
  let resolved = input;
  if (!use.keepPlaceholders && use.destinationHost && hasPlaceholder(input)) {
    const result = substituteWith(input, secrets, use.destinationHost);
    if (result.unknown.length > 0) {
      throw new SecretUseError(
        `Unknown secret(s): ${result.unknown.join(", ")}. Available to this person: ${[...secrets.keys()].sort().join(", ") || "none"}. Offer to add it with request-secret.`,
      );
    }
    if (result.blocked.length > 0) {
      throw new SecretUseError(
        `Secret(s) ${result.blocked.join(", ")} can't be sent to ${use.destinationHost}; each secret only works for the hosts it was added for.`,
      );
    }
    resolved = result.value;
    if (result.used.length > 0) {
      emit("secret_used", {
        userId: use.userId ?? null,
        sessionKey: use.sessionKey ?? null,
        source: "tool",
        meta: { tool: use.toolName, names: result.used, host: use.destinationHost },
      });
    }
  }
  return redactWith(await execute(resolved), secrets);
}

export async function secretsPrompt(userId: string | null): Promise<string> {
  let secrets: Map<string, UsableSecret>;
  try {
    secrets = await usableSecrets(userId);
  } catch {
    return "";
  }
  const lines = [...secrets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, secret]) => `- ${placeholder(name)} (${secret.scope}, works for: ${secret.allowedHosts.join(", ") || "no hosts yet"})`);
  return `[Secrets]
${lines.length > 0 ? `Secrets this person can use:\n${lines.join("\n")}` : "This person has no secrets yet."}
Put a placeholder verbatim into http-request (or an integration tool) where the value is needed; it is filled in only when the tool runs, only for the hosts the secret was added for, and tool results show the placeholder again. You never see the values: don't guess them and never ask anyone to paste a key, token or password into the chat. When a task needs a credential this person doesn't have, call request-secret so they can add it privately; personal secrets are theirs only, company secrets work for everyone and only admins add them.`;
}
