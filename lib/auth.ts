import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { admin } from "better-auth/plugins";
import { config } from "./config.ts";
import { db } from "./db/index.ts";
import { account, session, users, verification } from "./db/schema.ts";
import { ALLOWED_DOMAIN, AUTH_COOKIE_PREFIX, GOOGLE_CALENDAR_SCOPE, GOOGLE_CALLBACK_PATH } from "./auth-constants.ts";

export const auth = betterAuth({
  baseURL: config.appUrl,
  secret: config.betterAuthSecret,
  database: drizzleAdapter(db, { provider: "pg", schema: { users, session, account, verification } }),
  user: {
    modelName: "users",
    fields: { createdAt: "insertedAt" },
    additionalFields: {
      slackId: { type: "string", required: true, input: false },
      slackDmChannelId: { type: "string", required: true, input: false },
    },
  },
  session: { cookieCache: { enabled: true, maxAge: 5 * 60 } },
  account: { accountLinking: { enabled: true, trustedProviders: ["google"] } },
  socialProviders: {
    google: {
      clientId: config.googleClientId ?? "",
      clientSecret: config.googleClientSecret ?? "",
      hd: ALLOWED_DOMAIN,
      accessType: "offline",
      prompt: "consent",
      scope: [GOOGLE_CALENDAR_SCOPE],
      disableSignUp: true,
      overrideUserInfoOnSignIn: true,
      redirectURI: `${config.appUrl}${GOOGLE_CALLBACK_PATH}`,
    },
  },
  advanced: { cookiePrefix: AUTH_COOKIE_PREFIX, database: { generateId: "uuid" } },
  plugins: [admin({ defaultRole: "user", adminRoles: ["admin"] }), nextCookies()],
});
