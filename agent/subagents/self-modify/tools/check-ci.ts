import { setTimeout as sleep } from "node:timers/promises";
import { z } from "zod";
import { checkRuns, jobLog, type CheckRun } from "../../../../lib/github.ts";
import { defineManfrodTool } from "../../../lib/define-tool.ts";
import { proposal } from "../../../lib/self-modify.ts";

const POLL_MS = 15_000;
const LOG_LINES = 120;
const FAILED = new Set(["failure", "timed_out", "cancelled", "action_required", "startup_failure"]);

const logTail = (log: string) =>
  log
    .split("\n")
    .map((line) => line.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z /, "").replace(/\x1b\[[0-9;]*m/g, ""))
    .slice(-LOG_LINES)
    .join("\n");

export default defineManfrodTool({
  description:
    "Wait for the GitHub checks on the latest published commit and report them. For a failed check it returns the end of its log. If checks are still running when the wait ends, call it again.",
  inputSchema: z.object({
    wait_seconds: z.number().int().min(0).max(540).optional().describe("How long to wait for running checks (default 300)"),
  }),
  label: { start: () => "Waiting for CI", complete: (_input, output) => output.split("\n")[0] },
  async execute({ wait_seconds }, _ctx, runtime) {
    const { headSha, pullUrl } = proposal.get();
    if (!headSha) return "Nothing has been published yet; call publish-proposal first.";
    const deadline = Date.now() + (wait_seconds ?? 300) * 1000;
    let runs: CheckRun[] = [];
    for (;;) {
      runs = await checkRuns(headSha);
      const settled = runs.length > 0 && runs.every((run) => run.status === "completed");
      if (settled || Date.now() + POLL_MS > deadline) break;
      await sleep(POLL_MS, undefined, { signal: runtime.abortSignal });
    }
    if (runs.length === 0) return `No checks have started yet for ${headSha.slice(0, 7)}; call check-ci again shortly.`;

    const pending = runs.filter((run) => run.status !== "completed");
    const failed = runs.filter((run) => run.conclusion !== null && FAILED.has(run.conclusion));
    const summary = runs.map((run) => `- ${run.name}: ${run.status === "completed" ? run.conclusion : run.status}`).join("\n");
    const headline = pending.length > 0 ? "CI still running" : failed.length > 0 ? "CI failed" : "CI passed";
    const logs = await Promise.all(failed.map(async (run) => `### ${run.name}\n${logTail(await jobLog(run.id))}`));
    return [`${headline} for ${headSha.slice(0, 7)} (${pullUrl})`, summary, ...logs].join("\n\n");
  },
});
