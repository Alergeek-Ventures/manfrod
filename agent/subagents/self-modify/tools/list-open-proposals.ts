import { z } from "zod";
import { describeProposals, openProposals } from "../../../../lib/self-modify-pulls.ts";
import { defineManfrodTool } from "../../../lib/define-tool.ts";
import { authorize } from "../../../lib/self-modify.ts";

export default defineManfrodTool({
  description:
    "List your open self-modify pull requests with their titles, links and descriptions. Call it before checkout-repo to see whether one already does or partly does what you were asked.",
  inputSchema: z.object({}),
  label: { start: () => "Listing open self-modify pull requests" },
  async execute(_input, ctx) {
    const requester = await authorize(ctx);
    if (typeof requester === "string") return requester;
    const pulls = await openProposals();
    if (pulls.length === 0) return "There are no open self-modify pull requests.";
    return `Open self-modify pull requests:\n${describeProposals(pulls)}`;
  },
});
