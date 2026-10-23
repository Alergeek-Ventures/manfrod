import { asc, eq } from "drizzle-orm";
import { db } from "./db/index.ts";
import { agentSecrets } from "./db/schema.ts";
import { emit } from "./events/index.ts";
import { decrypt, encrypt } from "./vault.ts";

export const SECRET_NAME = /^[A-Z][A-Z0-9_]{1,63}$/;
const PLACEHOLDER = /\{\{\s*([A-Z][A-Z0-9_]{1,63})\s*\}\}/g;
const CACHE_TTL_MS = 30_000;
const MIN_REDACT_LENGTH = 4;

export interface SecretSummary {
  name: string;
  description: string | null;
  updatedAt: Date;
  updatedByUserId: string | null;
}

let cache: { values: Map<string, string>; loadedAt: number } | null = null;

export function placeholder(name: string): string {
  return `{{ ${name} }}`;
}

export async function listSecrets(): Promise<SecretSummary[]> {
  return db
    .select({
      name: agentSecrets.name,
      description: agentSecrets.description,
      updatedAt: agentSecrets.updatedAt,
      updatedByUserId: agentSecrets.updatedByUserId,
    })
    .from(agentSecrets)
    .orderBy(asc(agentSecrets.name));
}

export async function setSecret(name: string, value: string, description: string | null, userId: string): Promise<void> {
  if (!SECRET_NAME.test(name)) throw new Error("Name must be UPPER_SNAKE_CASE (A-Z, 0-9, _), 2-64 characters.");
  if (value === "") throw new Error("Value can't be blank.");
  await db
    .insert(agentSecrets)
    .values({ name, value: encrypt(value), description, updatedByUserId: userId })
    .onConflictDoUpdate({ target: agentSecrets.name, set: { value: encrypt(value), description, updatedByUserId: userId } });
  cache = null;
  emit("secret_updated", { userId, source: "admin", meta: { name } });
}

export async function updateSecretDescription(name: string, description: string | null, userId: string): Promise<void> {
  await db.update(agentSecrets).set({ description, updatedByUserId: userId }).where(eq(agentSecrets.name, name));
}

export async function deleteSecret(name: string, userId: string): Promise<void> {
  await db.delete(agentSecrets).where(eq(agentSecrets.name, name));
  cache = null;
  emit("secret_deleted", { userId, source: "admin", meta: { name } });
}

async function secretValues(): Promise<Map<string, string>> {
  if (cache && Date.now() - cache.loadedAt < CACHE_TTL_MS) return cache.values;
  const rows = await db.select({ name: agentSecrets.name, value: agentSecrets.value }).from(agentSecrets);
  const values = new Map(rows.map((row) => [row.name, decrypt(row.value)]));
  cache = { values, loadedAt: Date.now() };
  return values;
}

export async function secretNames(): Promise<string[]> {
  return [...(await secretValues()).keys()].sort();
}

function mapStrings(value: unknown, fn: (text: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn));
  if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, mapStrings(inner, fn)]));
  }
  return value;
}

export class UnknownSecretError extends Error {
  constructor(readonly names: string[], available: string[]) {
    super(
      `Unknown secret placeholder(s): ${names.join(", ")}. ` +
        (available.length > 0 ? `Available: ${available.join(", ")}.` : "No secrets are configured.") +
        " Secrets are managed by an admin in the web app.",
    );
  }
}

export function substituteWith<T>(input: T, values: Map<string, string>): { value: T; used: string[]; unknown: string[] } {
  const used = new Set<string>();
  const unknown = new Set<string>();
  const value = mapStrings(input, (text) =>
    text.replace(PLACEHOLDER, (match, name: string) => {
      const secret = values.get(name);
      if (secret === undefined) {
        unknown.add(name);
        return match;
      }
      used.add(name);
      return secret;
    }),
  ) as T;
  return { value, used: [...used], unknown: [...unknown] };
}

export function redactWith<T>(output: T, values: Map<string, string>): T {
  const entries = [...values.entries()].filter(([, secret]) => secret.length >= MIN_REDACT_LENGTH).sort((a, b) => b[1].length - a[1].length);
  if (entries.length === 0) return output;
  return mapStrings(output, (text) => entries.reduce((acc, [name, secret]) => acc.split(secret).join(placeholder(name)), text)) as T;
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
}

export async function runWithSecrets<I, R>(use: SecretUse, input: I, execute: (resolved: I) => Promise<R>): Promise<R> {
  let values: Map<string, string> | null = null;
  let resolved = input;
  if (!use.keepPlaceholders && hasPlaceholder(input)) {
    values = await secretValues();
    const result = substituteWith(input, values);
    if (result.unknown.length > 0) throw new UnknownSecretError(result.unknown, [...values.keys()].sort());
    resolved = result.value;
    if (result.used.length > 0) {
      emit("secret_used", {
        userId: use.userId ?? null,
        sessionKey: use.sessionKey ?? null,
        source: "tool",
        meta: { tool: use.toolName, names: result.used },
      });
    }
  }
  const output = await execute(resolved);
  values ??= await secretValues();
  return redactWith(output, values);
}
