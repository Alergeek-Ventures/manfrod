import { z } from "zod";
import { normalizeHosts, placeholder, SECRET_NAME } from "../../lib/secrets.ts";
import { post } from "../../lib/slack/api.ts";
import { secretButton } from "../../lib/slack/secret-modal.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  keepSecretPlaceholders: true,
  description:
    "Offer the person a button that opens a private Slack form to add a secret (an API key, token or password) without pasting it into the chat. Use it when a task needs a credential they don't have yet. Suggest a clear UPPER_SNAKE_CASE name and the exact API hosts it may be sent to. Personal secrets are only theirs; propose scope 'company' only when an admin wants everyone to use it.",
  inputSchema: z.object({
    name: z.string().describe("Suggested name, e.g. GITHUB_TOKEN"),
    hosts: z.array(z.string()).min(1).max(5).describe("Hosts it may be sent to, e.g. ['api.github.com']"),
    message: z.string().min(1).max(500).describe("One or two sentences explaining what it's for, in the conversation's language"),
    button_label: z.string().min(1).max(40).describe("Button text in the conversation's language, e.g. 'Dodaj sekret'"),
    description: z.string().max(200).optional().describe("Short description stored with the secret"),
    scope: z.enum(["personal", "company"]).optional().describe("Default personal"),
  }),
  async execute({ name, hosts, message, button_label, description, scope }, ctx) {
    const normalized = name.trim().toUpperCase();
    if (!SECRET_NAME.test(normalized)) return `Invalid name ${name}: use UPPER_SNAKE_CASE.`;
    let allowedHosts: string[];
    try {
      allowedHosts = normalizeHosts(hosts);
    } catch (error) {
      return (error as Error).message;
    }
    const { channel, threadTs } = ctx.msgCtx;
    if (!channel) return "There is no Slack conversation to post the button in.";
    const request = { name: normalized, hosts: allowedHosts, description: description ?? null, scope: scope ?? "personal" };
    const sent = await post("chat.postMessage", {
      channel,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      text: message,
      blocks: [{ type: "section", text: { type: "mrkdwn", text: message } }, secretButton(request, button_label)],
    });
    return sent.ok
      ? `Posted a button to add ${placeholder(normalized)} for ${allowedHosts.join(", ")}. Wait for the person to add it and tell you to continue; don't ask for the value.`
      : `Could not post the button: ${sent.error}`;
  },
});
