import { inArray } from "drizzle-orm";
import { db, tables } from "./db/index.ts";
import { getActiveMapping } from "./memory/access.ts";

const { agentSettings } = tables;
const CACHE_MS = 60_000;

export const LANGUAGES = {
  pl: "Polish",
  en: "English",
  de: "German",
  uk: "Ukrainian",
  es: "Spanish",
  fr: "French",
} as const;

export type LanguageCode = keyof typeof LANGUAGES;
export type Audience = "internal" | "external";

const KEYS: Record<Audience, string> = { internal: "language.internal", external: "language.external" };
const DEFAULTS: Record<Audience, LanguageCode> = { internal: "pl", external: "en" };

export const isLanguageCode = (value: unknown): value is LanguageCode => typeof value === "string" && value in LANGUAGES;

let cached: { value: Record<Audience, LanguageCode>; at: number } | null = null;

export async function languageSettings(): Promise<Record<Audience, LanguageCode>> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const rows = await db
    .select()
    .from(agentSettings)
    .where(inArray(agentSettings.key, Object.values(KEYS)));
  const stored = new Map(rows.map((row) => [row.key, row.value]));
  const pick = (audience: Audience) => {
    const value = stored.get(KEYS[audience]);
    return isLanguageCode(value) ? value : DEFAULTS[audience];
  };
  const value = { internal: pick("internal"), external: pick("external") };
  cached = { value, at: Date.now() };
  return value;
}

export async function setLanguages(languages: Record<Audience, LanguageCode>, userId: string | null): Promise<void> {
  for (const audience of ["internal", "external"] as const) {
    await db
      .insert(agentSettings)
      .values({ key: KEYS[audience], value: languages[audience], updatedByUserId: userId })
      .onConflictDoUpdate({
        target: agentSettings.key,
        set: { value: languages[audience], updatedByUserId: userId, updatedAt: new Date() },
      });
  }
  cached = null;
}

export async function channelLanguage(channelId: string | null): Promise<{ audience: Audience; name: string }> {
  const languages = await languageSettings();
  const external = channelId !== null && !channelId.startsWith("D") && Boolean((await getActiveMapping(channelId))?.clientId);
  const audience: Audience = external ? "external" : "internal";
  return { audience, name: LANGUAGES[languages[audience]] };
}

export async function internalLanguage(): Promise<string> {
  return LANGUAGES[(await languageSettings()).internal];
}

export async function languageInstructions(channelId: string | null): Promise<string> {
  const { audience, name } = await channelLanguage(channelId);
  if (audience === "external") {
    return `[Language]\nThis is an official channel shared with a client. Write in ${name}, even if the team talks to you in another language.`;
  }
  if (!channelId || channelId.startsWith("D")) {
    return `[Language]\nWrite in ${name} by default. If this person asks you to use another language, or your notes say they prefer one, use that language instead.`;
  }
  return `[Language]\nThis is an internal team channel. Write in ${name}.`;
}
