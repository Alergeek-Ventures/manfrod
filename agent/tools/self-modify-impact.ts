import { z } from "zod";
import { getUser, isAdmin } from "../../lib/accounts.ts";
import { getPull } from "../../lib/github.ts";
import { impactReport, postVerdict } from "../../lib/self-modify-merge/impact.ts";
import { mergedPull } from "../../lib/self-modify-merge/store.ts";
import { SELF_REVIEW_SLACK_ID } from "../../lib/self-review/rules.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  keepSecretPlaceholders: true,
  description:
    "For a self-modify pull request that merged on its own: without verdict, list how often the changed skill or routine was used and how many negative ratings (👎 and inferred) those conversations got before and after the deploy, with links. With verdict and summary, post the verdict in the pull request's self-review thread and close its verification task. Admins and self-review only.",
  inputSchema: z.object({
    pull_number: z.number().int().positive().describe("The pull request number"),
    verdict: z
      .enum(["better", "no_change", "worse", "not_enough_data"])
      .optional()
      .describe("Only when you are done: your verdict on whether conversations go better since the deploy"),
    summary: z.string().min(1).max(600).optional().describe("With verdict: one or two sentences with the numbers behind it"),
  }),
  label: { start: ({ pull_number }) => `Checking the effect of #${pull_number}` },
  async execute({ pull_number, verdict, summary }, ctx) {
    const user = await getUser(ctx.userId);
    if (!isAdmin(user) && user?.slackId !== SELF_REVIEW_SLACK_ID) return "Only an admin or Manfrod's self-review can do that.";
    const merge = await mergedPull(pull_number);
    if (!merge) return `#${pull_number} was not merged automatically.`;
    const pullUrl = (await getPull(pull_number))?.url ?? null;
    if (!verdict) return impactReport(merge, pullUrl);
    if (!summary) return "Add a summary with the numbers behind the verdict.";
    if (!merge.liveAt) return `#${pull_number} is not live in production yet, so there is nothing to judge.`;
    return postVerdict(merge, pullUrl, verdict, summary);
  },
});
