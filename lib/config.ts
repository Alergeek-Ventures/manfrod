import { createHash } from "node:crypto";
const env = (key: string): string | undefined => {
  const value = process.env[key];
  return value === undefined || value === "" ? undefined : value;
};

export const config = {
  adminEmails: ["franek@alergeek.ventures", "kamil@alergeek.ventures"],
  timezone: "Europe/Warsaw",
  get slackStreaming() {
    return env("SLACK_STREAMING") !== "false";
  },
  get zenApiKey() {
    return env("ZEN_API_KEY");
  },
  get openrouterApiKey() {
    return env("OPENROUTER_API_KEY");
  },
  get groqApiKey() {
    return env("GROQ_API_KEY");
  },
  get voyageApiKey() {
    return env("VOYAGE_API_KEY");
  },
  get braveSearchApiKey() {
    return env("BRAVE_SEARCH_API_KEY");
  },
  get slackBotToken() {
    return env("SLACK_BOT_TOKEN");
  },
  get slackSigningSecret() {
    return env("SLACK_SIGNING_SECRET");
  },
  get googleClientId() {
    return env("GOOGLE_CLIENT_ID");
  },
  get googleClientSecret() {
    return env("GOOGLE_CLIENT_SECRET");
  },
  get googleApiKey() {
    return env("GOOGLE_API_KEY");
  },
  get holidayCalendarId() {
    return env("HOLIDAY_CALENDAR_ID") ?? "pl.polish#holiday@group.v.calendar.google.com";
  },
  get kalafiorniaOfficeAccessApiKey() {
    return env("KALAFIORNIA_OFFICE_ACCESS_API_KEY");
  },
  get linearEncryptionKey() {
    return env("LINEAR_ENCRYPTION_KEY") ?? "N0G8yzhz8v1uS0kDf1PBjaVAd7RITiXHhJI3q6Pn0lU=";
  },
  get internalApiSecret() {
    return env("INTERNAL_API_SECRET") ?? env("SECRET_KEY_BASE") ?? "manfrod-local-internal-secret";
  },
  get betterAuthSecret() {
    return env("BETTER_AUTH_SECRET") ?? createHash("sha256").update(`better-auth:${this.linearEncryptionKey}`).digest("base64");
  },
  get appUrl() {
    const explicit = env("APP_URL");
    if (explicit) return explicit.replace(/\/$/, "");
    const host = env("PHX_HOST");
    if (host && host !== "localhost") return `https://${host}`;
    return `http://localhost:${env("PORT") ?? "35233"}`;
  },
  get internalUrl() {
    return env("INTERNAL_URL") ?? `http://127.0.0.1:${env("PORT") ?? "35233"}`;
  },
  get decisionModel() {
    return env("DECISION_MODEL") ?? "jev-latest";
  },
  get cronsEnabled() {
    return env("DISABLE_CRONS") !== "1";
  },
  get typesafeApiKey() {
    return env("TYPESAFE_AI_API_KEY");
  },
  get isProduction() {
    return process.env.NODE_ENV === "production";
  },
};

export function isAdminEmail(email: string | null | undefined): boolean {
  return typeof email === "string" && config.adminEmails.includes(email);
}
