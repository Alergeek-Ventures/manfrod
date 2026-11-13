import { createHash } from "node:crypto";
const env = (key: string): string | undefined => {
  const value = process.env[key];
  return value === undefined || value === "" ? undefined : value;
};

export const config = {
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
  get gmailMcpEnabled() {
    return env("GMAIL_MCP_ENABLED") === "true";
  },
  get googleMcpClientId() {
    return env("GOOGLE_MCP_CLIENT_ID");
  },
  get googleMcpClientSecret() {
    return env("GOOGLE_MCP_CLIENT_SECRET");
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
  get linearClientId() {
    return env("LINEAR_CLIENT_ID");
  },
  get linearClientSecret() {
    return env("LINEAR_CLIENT_SECRET");
  },
  get encryptionKey() {
    const key = env("ENCRYPTION_KEY") ?? env("LINEAR_ENCRYPTION_KEY");
    if (!key) throw new Error("ENCRYPTION_KEY is not set");
    return key;
  },
  get internalApiSecret() {
    return env("INTERNAL_API_SECRET") ?? env("SECRET_KEY_BASE") ?? "manfrod-local-internal-secret";
  },
  get betterAuthSecret() {
    const explicit = env("BETTER_AUTH_SECRET");
    if (explicit) return explicit;
    // next build evaluates lib/auth.ts before runtime secrets exist
    if (process.env.NEXT_PHASE === "phase-production-build") return "build-time-placeholder";
    return createHash("sha256").update(`better-auth:${this.encryptionKey}`).digest("base64");
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
  get githubAppId() {
    return env("GITHUB_APP_ID");
  },
  get githubAppPrivateKey() {
    return env("GITHUB_APP_PRIVATE_KEY")?.replaceAll("\\n", "\n");
  },
  get githubAppClientId() {
    return env("GITHUB_APP_CLIENT_ID");
  },
  get githubAppClientSecret() {
    return env("GITHUB_APP_CLIENT_SECRET");
  },
  get githubWebhookSecret() {
    return env("GITHUB_WEBHOOK_SECRET");
  },
  get selfReviewChannelId() {
    return env("SELF_REVIEW_CHANNEL_ID");
  },
  get githubRepository() {
    return env("GITHUB_REPOSITORY") ?? "Alergeek-Ventures/manfrod";
  },
  get typesafeApiKey() {
    return env("TYPESAFE_AI_API_KEY");
  },
  get isProduction() {
    return process.env.NODE_ENV === "production";
  },
};
