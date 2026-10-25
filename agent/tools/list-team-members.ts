import { z } from "zod";
import { isSystemUser, listUsers } from "../../lib/accounts.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description: "List everyone Manfrod knows about (id + name) — for holiday-check fan-out.",
  inputSchema: z.object({}),
  async execute() {
    const members = (await listUsers()).filter((user) => !isSystemUser(user));
    if (members.length === 0) return "No team members found.";
    return members.map((user) => `- ${user.id}: ${user.name ?? user.email}`).join("\n");
  },
});
