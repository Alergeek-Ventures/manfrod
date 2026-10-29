import { z } from "zod";
import { isSystemUser, listUsers } from "../../lib/accounts.ts";
import { deactivatedSlackIds } from "../../lib/slack/api.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description:
    "List everyone Manfrod knows about (id, name and Slack ID) — for finding the Slack ID to mention someone with <@SLACK_ID>. People whose Slack account is deactivated are listed separately; never mention or message them.",
  inputSchema: z.object({}),
  async execute() {
    const deactivated = await deactivatedSlackIds();
    const members = (await listUsers()).filter((user) => !isSystemUser(user));
    if (members.length === 0) return "No team members found.";
    const line = (user: (typeof members)[number]) => `- ${user.id}: ${user.name ?? user.email} (Slack ID: ${user.slackId})`;
    const active = members.filter((user) => !deactivated.has(user.slackId));
    const gone = members.filter((user) => deactivated.has(user.slackId));
    return [active.map(line).join("\n"), gone.length > 0 ? `Deactivated on Slack:\n${gone.map(line).join("\n")}` : ""]
      .filter(Boolean)
      .join("\n\n");
  },
});
