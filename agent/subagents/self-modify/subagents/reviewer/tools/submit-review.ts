import { z } from "zod";
import { recordReview } from "../../../../../../lib/self-modify-pulls.ts";
import { defineManfrodTool } from "../../../../../lib/define-tool.ts";
import { authorize, diffFingerprint } from "../../../../../lib/self-modify.ts";
import { environment } from "../sandbox.ts";

export default defineManfrodTool({
  description:
    "Record your verdict on the changes as they are now. Call it once, at the end of each review. publish-proposal reads it, so a verdict covers only the exact changes you reviewed.",
  inputSchema: z.object({
    verdict: z.enum(["approve", "request_changes"]),
    findings: z
      .string()
      .max(8000)
      .describe(
        "Findings ordered by severity, one per line: severity, file:line, the problem and the fix. Empty when approving without remarks",
      ),
  }),
  label: { start: ({ verdict }) => `Recording review: ${verdict}` },
  async execute({ verdict, findings }, ctx, runtime) {
    const requester = await authorize(ctx);
    if (typeof requester === "string") return requester;
    const parent = runtime.session.parent?.sessionId;
    if (!parent) return "This tool only works inside a self-modify review.";
    const sandbox = await runtime.getSandbox(environment);
    await recordReview(parent, await diffFingerprint(sandbox), verdict, findings.trim());
    return `Recorded: ${verdict}.`;
  },
});
