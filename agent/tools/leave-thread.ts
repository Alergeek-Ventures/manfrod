import { z } from "zod";
import { runKick } from "../../lib/slack/kick.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

export default defineManfrodTool({
  description:
    "Stop participating in the current channel thread. Call this when someone in the thread asks you to stop replying, to leave them alone, or to butt out — e.g. 'przestań się tu udzielać', 'zostaw nas', 'nie odzywaj się więcej w tym wątku', or to only speak when asked or mentioned directly, e.g. 'odzywaj się tylko jak ktoś cię zawoła', 'only reply when someone tags you'. You will post a short goodbye and then stay silent in this thread until someone @mentions you again. Do not call this on your own initiative, only when asked.",
  inputSchema: z.object({}),
  async execute(_args, ctx) {
    const { channel, threadTs, slackUserId } = ctx.msgCtx;
    if (!channel || !threadTs) {
      return "Not in a channel thread, so there is nothing to leave. If this is a DM, explain that you can't leave a private conversation, and that they can mute or archive it instead.";
    }
    const result = await runKick(channel, threadTs, { slackUserId, source: "tool" });
    if (result === "ok") return "Left the thread and posted a goodbye. Say nothing further — the goodbye has already been sent.";
    if (result === "already_kicked") return "Already out of this thread; nothing to do. Say nothing further.";
    return "Could not leave the thread: :error";
  },
});
