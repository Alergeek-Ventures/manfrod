import { z } from "zod";
import { cancelJob, getJob } from "../../lib/jobs/index.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description: "Cancel a pending reminder by its job ID.",
  inputSchema: z.object({ id: z.number().int().describe("The job ID of the reminder to cancel") }),
  async execute({ id }) {
    if (await getJob(id)) await cancelJob(id);
    return `Reminder #${id} cancelled.`;
  },
});
