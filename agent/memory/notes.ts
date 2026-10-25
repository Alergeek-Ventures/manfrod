import { defineMemory, defineMemoryProvider } from "eve/memory";
import { logger } from "../../lib/log.ts";
import { projectIdForChannel } from "../../lib/memory/access.ts";
import { getNoteContext } from "../../lib/memory/search.ts";
import { toolCtx } from "../../lib/agent/context.ts";

const NOTE_QUERY_CHARS = 2_000;
const log = logger("Agent.Notes");

function inputText(input: unknown): string {
  const messages = Array.isArray(input) ? input : [input];
  return messages
    .flatMap((message: any) => {
      const content = message?.content ?? message;
      if (typeof content === "string") return [content];
      if (Array.isArray(content)) return content.filter((part) => part?.type === "text").map((part) => part.text as string);
      return [];
    })
    .join("\n\n");
}

export default defineMemory({
  description: "Relevant notes from the shared zettelkasten, scoped to what the current author may read.",
  scope: (ctx) => ctx.session.id,
  visibility: "session",
  provider: defineMemoryProvider({
    recall: {
      async "turn.started"(ctx) {
        const tool = toolCtx(ctx);
        if (!tool.userId || tool.kind === "skill_channel") return null;
        const text = inputText(ctx.turn?.input);
        if (text.trim() === "") return null;
        const query = text.length > NOTE_QUERY_CHARS ? text.slice(-NOTE_QUERY_CHARS) : text;
        try {
          const projectId = tool.msgCtx.channel ? await projectIdForChannel(tool.msgCtx.channel) : null;
          const notes = await getNoteContext(tool.userId, tool.readableLevels, query, projectId);
          return notes === "" ? null : { messages: [{ id: "note-context", content: `[Note context]\n${notes}` }] };
        } catch (error) {
          log.error(`Agent.Server: note context failed: ${(error as Error).message}`);
          return null;
        }
      },
    },
  }),
});
