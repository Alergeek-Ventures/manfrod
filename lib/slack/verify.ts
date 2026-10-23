import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.ts";

const MAX_AGE_SECONDS = 60 * 5;

export function verifySlackSignature(headers: Headers, body: string, now = Date.now()): boolean {
  const secret = config.slackSigningSecret;
  const timestamp = headers.get("x-slack-request-timestamp");
  const signature = headers.get("x-slack-signature");
  if (!secret || !timestamp || !signature) return false;
  if (Math.abs(Math.floor(now / 1000) - Number(timestamp)) > MAX_AGE_SECONDS) return false;
  const expected = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
  const given = Buffer.from(signature);
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}
