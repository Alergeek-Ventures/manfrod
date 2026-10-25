import { z } from "zod";
import { getFact, listFacts } from "../facts.ts";
import { privateLevel } from "../memory/access.ts";
import { escalateNoteAccess, getNodeAccessible, getSoul, setSoul, updateSoul } from "../memory/nodes.ts";
import { addOp } from "../memory/pending.ts";
import { listProjects } from "../memory/projects.ts";
import { webSearchText } from "../memory/retrospector.ts";
import { getBody } from "../skills.ts";
import { isUuid } from "../accounts.ts";
import { runKick } from "../slack/kick.ts";
import { embedQuery } from "../voyage.ts";
import { flaggable, spec } from "./context.ts";

export const tools = {
  get_soul: spec({
    description:
      "Show your soul for the person you are talking to: the core note that opens every conversation with them (who they are, how to work with them, who you are for them). Use when they ask what is in it, and before changing it.",
    inputSchema: z.object({}),
    async execute(_args, ctx) {
      const soul = await getSoul(ctx.userId);
      return soul ? `Soul [${soul.id}]:\n${soul.content}` : "There is no soul yet. update_soul creates one.";
    },
  }),

  update_soul: spec({
    keepSecretPlaceholders: true,
    description:
      "Rewrite your soul for the person you are talking to. Only when they explicitly ask you to change it (e.g. 'zapisz w swojej duszy...', 'zmień swoją osobowość na...'). Pass the complete new text: read it with get_soul first and keep everything that still holds.",
    inputSchema: z.object({ content: z.string().describe("The complete new soul text") }),
    async execute({ content }, ctx) {
      const trimmed = content.trim();
      if (trimmed === "") return "The soul can't be empty.";
      try {
        const embedding = await embedQuery(trimmed);
        const soul = await updateSoul(ctx.userId, trimmed, embedding, [privateLevel(ctx.userId)]);
        return `Soul updated [${soul.id}]. It opens every new conversation from now on; act on it in this one already.`;
      } catch (error) {
        return `Failed to save the soul: ${(error as Error).message}`;
      }
    },
  }),

  set_soul_note: spec({
    keepSecretPlaceholders: true,
    description:
      "Make an existing note your soul for the person you are talking to, replacing the current one (which stays as an ordinary note). Only on their explicit request.",
    inputSchema: z.object({ note_id: z.string().describe("UUID of the note to make the soul") }),
    async execute({ note_id }, ctx) {
      if (!isUuid(note_id) || !(await getNodeAccessible(ctx.readableLevels, note_id))) return `Note not found: ${note_id}`;
      const soul = await setSoul(ctx.userId, note_id);
      return soul ? `Note [${soul.id}] is now the soul:\n${soul.content}` : `Note not found: ${note_id}`;
    },
  }),

  escalate_note: spec({
    description:
      "Flag an existing note to have its visibility widened (private → internal, or internal → external/client); applied by the background memory. Use when the user explicitly asks to share it more widely. Notes from DMs start private to that person, so sharing one with the team means escalating it to 'internal'.",
    inputSchema: z.object({
      node_id: z.string().describe("Note UUID"),
      new_access_level: z.string().describe("New access level to add: 'internal', 'external/10bps' or 'external/all'"),
    }),
    async execute({ node_id, new_access_level }, ctx) {
      const message = flaggable(ctx.msgCtx);
      if (message) {
        await addOp(message.channel, message.ts, {
          op: "escalate",
          node_id,
          level: new_access_level,
          readable_levels: ctx.readableLevels,
        });
        return `Zaznaczyłem do poszerzenia widoczności: ${node_id} → ${new_access_level}`;
      }
      const result = await escalateNoteAccess(node_id, new_access_level, ctx.readableLevels);
      if (result.ok) return `Nota ${node_id} teraz widoczna jako: ${new_access_level}`;
      return result.error === "not_found" ? `Nota nie znaleziona: ${node_id}` : `Błąd: :${result.error}`;
    },
  }),

  get_fact: spec({
    description: "Look up a structured fact by key (vacations, meetings). Key format: 'absence:user_id:date', 'meeting:channel:ts'.",
    inputSchema: z.object({ key: z.string().describe("Exact fact key") }),
    async execute({ key }, ctx) {
      const fact = await getFact(key, ctx.readableLevels);
      return fact ? `${fact.key}: ${fact.value}` : `Fact not found: ${key}`;
    },
  }),

  list_facts: spec({
    description: "List structured facts with a key prefix. E.g. prefix 'absence:' lists all vacations/absences you can see.",
    inputSchema: z.object({ prefix: z.string().describe("Key prefix to search") }),
    async execute({ prefix }, ctx) {
      const found = await listFacts(prefix, ctx.readableLevels);
      if (found.length === 0) return `No facts found with prefix: ${prefix}`;
      return found.map((fact) => `- ${fact.key}: ${fact.value}`).join("\n");
    },
  }),

  list_projects: spec({
    description:
      "List all known projects (name + slug). Use when you need to confirm or disambiguate a project the user named before filtering notes by it (e.g. via list_recent_notes' `project` parameter).",
    inputSchema: z.object({}),
    async execute() {
      const projects = await listProjects();
      if (projects.length === 0) return "No projects configured.";
      return `Projects:\n${projects.map((project) => `- ${project.name} (slug: ${project.slug})`).join("\n")}`;
    },
  }),

  use_skill: spec({
    description:
      "Load the full instructions for one of your Available Skills (listed in your system prompt) when it's relevant to the current message.",
    inputSchema: z.object({ name: z.string().describe("Skill name, e.g. 'vacation-tracking'") }),
    async execute({ name }) {
      return getBody(name) ?? `Skill not found: ${name}`;
    },
  }),

  web_search: spec({
    description:
      "Search the web for current information. Use this when you need up-to-date facts, news, documentation, or anything not in your notes.",
    inputSchema: z.object({ query: z.string().describe("Search query - what to look up on the web") }),
    async execute({ query }) {
      return webSearchText(query);
    },
  }),

  leave_thread: spec({
    description:
      "Stop participating in the current channel thread. Call this when someone in the thread asks you to stop replying, to leave them alone, or to butt out — e.g. 'przestań się tu udzielać', 'zostaw nas', 'nie odzywaj się więcej w tym wątku'. You will post a short goodbye and then stay silent in this thread until someone @mentions you again. Do not call this on your own initiative, only when asked.",
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
  }),
};
