import { z } from "zod";
import { defineManfrodTool } from "../../../../../lib/define-tool.ts";
import { authorize, BASE_TAG, sh } from "../../../../../lib/self-modify.ts";
import { environment } from "../sandbox.ts";

const MAX_CHARS = 80_000;

export default defineManfrodTool({
  description: "Show every change in the checkout under review against the code it started from: a file summary, then the full diff.",
  inputSchema: z.object({}),
  label: { start: () => "Reading the changes" },
  async execute(_input, ctx, runtime) {
    const requester = await authorize(ctx);
    if (typeof requester === "string") return requester;
    const sandbox = await runtime.getSandbox(environment);
    const stat = await sh(sandbox, `git add -A && git diff --cached --stat ${BASE_TAG}`);
    if (stat.trim() === "") return "There are no changes in the checkout.";
    const diff = await sh(sandbox, `git diff --cached ${BASE_TAG}`);
    const shown =
      diff.length > MAX_CHARS ? `${diff.slice(0, MAX_CHARS)}\n…(diff truncated; read the remaining files with read_file)` : diff;
    return `${stat}\n${shown}`;
  },
});
