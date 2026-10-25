import { z } from "zod";
import { openDoor } from "../../lib/kalafiornia.ts";
import { DOOR_ID } from "../lib/office.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description:
    "Opens the office door via the Kalafiornia app, using the caller's own connected Kalafiornia session. If they haven't connected it, returns an error asking them to log in at the web app's integrations page.",
  inputSchema: z.object({}),
  async execute(_args, ctx) {
    const result = await openDoor(ctx.userId, DOOR_ID);
    if (result.ok) return "Door opened.";
    if (result.error === "not_connected") {
      return "ERROR: No Kalafiornia account connected. The user needs to log in at the web app's integrations page (/integrations).";
    }
    if (result.error === "session_invalid") {
      return "ERROR: Kalafiornia session expired. The user needs to log in again at the web app's integrations page (/integrations).";
    }
    return `Kalafiornia door open failed: ${result.error}`;
  },
});
