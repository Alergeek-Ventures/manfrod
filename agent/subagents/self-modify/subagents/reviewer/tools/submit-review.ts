import { z } from "zod";
import { recordReview } from "../../../../../../lib/self-modify-pulls.ts";
import { defineManfrodTool } from "../../../../../lib/define-tool.ts";
import { authorize, isSnapshot, snapshotTree } from "../../../../../lib/self-modify.ts";
import { environment } from "../sandbox.ts";

export default defineManfrodTool({
  description:
    "Record your verdict on the snapshot you reviewed. Call it once, at the end of each review, with the snapshot id show-diff gave you. It is refused when the checkout changed after that snapshot; call show-diff again then. publish-proposal only publishes the exact snapshot you approved.",
  inputSchema: z.object({
    snapshot: z.string().describe("The snapshot id from show-diff"),
    verdict: z.enum(["approve", "request_changes"]),
    findings: z
      .string()
      .max(8000)
      .describe(
        "Findings ordered by severity, one per line: severity, file:line, the problem and the fix. Empty when approving without remarks",
      ),
  }),
  label: { start: ({ verdict }) => `Recording review: ${verdict}` },
  async execute({ snapshot, verdict, findings }, ctx, runtime) {
    const requester = await authorize(ctx);
    if (typeof requester === "string") return requester;
    const parent = runtime.session.parent?.sessionId;
    if (!parent) return "This tool only works inside a self-modify review.";
    const sandbox = await runtime.getSandbox(environment);
    if (!(await isSnapshot(sandbox, snapshot))) return `${snapshot} is not a snapshot from show-diff.`;
    if ((await snapshotTree(sandbox)) !== snapshot) {
      return "The checkout changed after your snapshot, so nothing was recorded. Call show-diff again and review what changed.";
    }
    await recordReview(parent, snapshot, verdict, findings.trim());
    return `Recorded: ${verdict} for snapshot ${snapshot}.`;
  },
});
