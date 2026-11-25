import { z } from "zod";
import { getUser, isAdmin } from "../../lib/accounts.ts";
import { openProposals } from "../../lib/self-modify-pulls.ts";
import { autoMergeStatus } from "../../lib/self-modify-merge/status.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description:
    "Admins only, read-only: whether your self-modify pull requests merge on their own. For each open one (or the one numbered) it says whether it qualifies for auto-merge and is waiting for CI or the security review, is blocked and why (a person has to merge it), or was merged or closed. Use it when someone asks what happened to a change they asked you for.",
  inputSchema: z.object({
    pull_number: z.number().int().positive().optional().describe("One self-modify pull request, open or not; omit for every open one"),
  }),
  label: { start: () => "Checking self-modify pull requests" },
  async execute({ pull_number }, ctx) {
    if (!isAdmin(await getUser(ctx.userId))) return "Only admins can check self-modify pull requests.";
    if (pull_number !== undefined) return autoMergeStatus(pull_number);
    const pulls = await openProposals();
    if (pulls.length === 0) return "There are no open self-modify pull requests.";
    return (await Promise.all(pulls.map((pull) => autoMergeStatus(pull.number)))).map((line) => `- ${line}`).join("\n");
  },
});
