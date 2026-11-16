import { z } from "zod";
import { defineManfrodTool } from "../../../../../lib/define-tool.ts";
import { authorize, BASE_TAG, sh, snapshotTree } from "../../../../../lib/self-modify.ts";
import { environment } from "../sandbox.ts";

const MAX_CHARS = 80_000;

export default defineManfrodTool({
  description:
    "Take a snapshot of the checkout under review and show every change in it against the code it started from: the snapshot id, a file summary, then the full diff. Pass the snapshot id to submit-review; read files of that snapshot with read_file only while nothing changes them.",
  inputSchema: z.object({}),
  label: { start: () => "Reading the changes" },
  async execute(_input, ctx, runtime) {
    const requester = await authorize(ctx);
    if (typeof requester === "string") return requester;
    const sandbox = await runtime.getSandbox(environment);
    const tree = await snapshotTree(sandbox);
    const stat = await sh(sandbox, `git diff --stat ${BASE_TAG} ${tree}`);
    if (stat.trim() === "") return `Snapshot ${tree}: there are no changes in the checkout.`;
    const diff = await sh(sandbox, `git diff ${BASE_TAG} ${tree}`);
    const shown =
      diff.length > MAX_CHARS ? `${diff.slice(0, MAX_CHARS)}\n…(diff truncated; read the remaining files with read_file)` : diff;
    return `Snapshot ${tree}\n${stat}\n${shown}`;
  },
});
