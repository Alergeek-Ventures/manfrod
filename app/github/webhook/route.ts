import { config } from "../../../lib/config.ts";
import { verifyWebhookSignature } from "../../../lib/github/oauth.ts";
import { handleWebhook } from "../../../lib/github/webhook.ts";
import { logger } from "../../../lib/log.ts";

const log = logger("Github.Webhook");

export async function POST(request: Request) {
  const secret = config.githubWebhookSecret;
  if (!secret) return new Response("GitHub webhooks are not configured.", { status: 503 });
  const body = await request.text();
  if (!verifyWebhookSignature(secret, body, request.headers.get("x-hub-signature-256"))) {
    return new Response("Invalid signature.", { status: 401 });
  }
  const event = request.headers.get("x-github-event") ?? "";
  try {
    await handleWebhook(event, JSON.parse(body));
  } catch (error) {
    log.error(`Github.Webhook: ${event} delivery ${request.headers.get("x-github-delivery")} failed: ${(error as Error).message}`);
    return new Response("Failed.", { status: 500 });
  }
  return new Response(null, { status: 204 });
}
