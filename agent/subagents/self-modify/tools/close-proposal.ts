import { z } from "zod";
import { closePull, commentOnPull, deleteBranch, getPull } from "../../../../lib/github.ts";
import { defineManfrodTool } from "../../../lib/define-tool.ts";
import { authorize, BRANCH_PREFIX, proposal } from "../../../lib/self-modify.ts";

export default defineManfrodTool({
  keepSecretPlaceholders: true,
  description:
    "Close one of your own self-modify pull requests without merging it and delete its branch. Only works for pull requests whose branch you created; anything else must be closed by a person on GitHub.",
  inputSchema: z.object({
    pull_number: z.number().int().positive().describe("Pull request number, e.g. 120"),
    reason: z.string().max(1000).optional().describe("Short English comment to leave on the pull request before closing it"),
  }),
  label: { start: ({ pull_number }) => `Closing pull request #${pull_number}`, complete: (_input, output) => output.split("\n")[0] },
  async execute({ pull_number, reason }, ctx) {
    const requester = await authorize(ctx);
    if (typeof requester === "string") return requester;
    if (requester.kind === "self_review" && requester.finding.pullNumber !== pull_number) {
      return `Self-review can only close the pull request it opened for this finding.`;
    }
    const pull = await getPull(pull_number);
    if (!pull) return `Pull request #${pull_number} not found.`;
    if (!pull.branch.startsWith(BRANCH_PREFIX)) return `Pull request #${pull_number} was not opened by self-modify, so I can't close it.`;
    if (pull.merged) return `Pull request #${pull_number} is already merged.`;
    if (pull.state !== "closed") {
      if (reason) await commentOnPull(pull_number, reason);
      await closePull(pull_number);
    }
    await deleteBranch(pull.branch);
    if (proposal.get().pullNumber === pull_number) {
      proposal.update((current) => ({ ...current, branch: null, headSha: null, pullNumber: null, pullUrl: null }));
    }
    return `Closed pull request #${pull_number} (${pull.url}) and deleted branch ${pull.branch}.`;
  },
});
