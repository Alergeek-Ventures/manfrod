import { z } from "zod";
import type { Node } from "../db/schema.ts";
import { projectIdForChannel } from "../memory/access.ts";
import {
  createLink,
  createNode,
  deleteLink,
  deleteNode,
  getNodeAccessible,
  getNodeLinks,
  getNodeLinksAccessible,
  isSoul,
  listNodesByDate,
} from "../memory/nodes.ts";
import { addOp, flagMessage } from "../memory/pending.ts";
import { findProject } from "../memory/projects.ts";
import { search } from "../memory/search.ts";
import { dateIsoInZone, isValidIsoDate, zonedToUtc } from "../time.ts";
import { embedQuery } from "../voyage.ts";
import { flaggable, spec, type MsgCtx } from "./context.ts";

const PROJECT_DOC =
  "Project name or slug to scope results to (use list_projects to confirm/disambiguate first if unsure). Omit to use the current channel's project, if this channel is mapped to one — otherwise no project scoping is applied.";

const noteDate = (node: Node) => dateIsoInZone(node.insertedAt);

const unknownProject = (name: string | undefined) =>
  `Nie znalazłem projektu "${name}" — sprawdź listę przez list_projects.`;

async function resolveProject(name: string | undefined, msgCtx: MsgCtx): Promise<{ ok: true; id: string | null } | { ok: false }> {
  if (name === undefined || name === null || name === "") {
    return { ok: true, id: msgCtx.channel ? await projectIdForChannel(msgCtx.channel) : null };
  }
  const project = await findProject(name);
  return project ? { ok: true, id: project.id } : { ok: false };
}

function dateBound(value: string | undefined, edge: "since" | "until"): Date | null | "invalid" {
  if (value === undefined || value === null) return null;
  if (!isValidIsoDate(value)) return "invalid";
  return zonedToUtc(value, edge === "since" ? "00:00:00" : "23:59:59");
}

export const tools = {
  search_notes: spec({
    description:
      "Search your zettelkasten for relevant notes. Use this when you need to find facts, preferences, or context not in the initial note context.",
    inputSchema: z.object({
      query: z.string().describe("Search query - what you want to find"),
      project: z.string().optional().describe(PROJECT_DOC),
    }),
    async execute({ query, project }, ctx) {
      const resolved = await resolveProject(project, ctx.msgCtx);
      if (!resolved.ok) return unknownProject(project);
      const found = await search(ctx.userId, ctx.readableLevels, query, { limit: 10, projectId: resolved.id });
      if (found.length === 0) return `No relevant notes found for: ${query}`;
      const lines = await Promise.all(
        found.map(async (node) => {
          const linked = (await getNodeLinks(ctx.userId, node.id)).map((other) => other.id).join(", ");
          const line = `- ${noteDate(node)} [${node.id}] ${node.content}`;
          return linked === "" ? line : `${line}\n  Linked to: ${linked}`;
        }),
      );
      return `Found ${found.length} notes:\n${lines.join("\n")}`;
    },
  }),

  list_recent_notes: spec({
    description:
      "List notes in chronological order (newest first), optionally bounded to a date range and/or scoped to one project. Use for activity/project summaries — 'what happened today', 'this week', 'between two dates' — where you need everything in time order, not a relevance search like search_notes.",
    inputSchema: z.object({
      since: z
        .string()
        .optional()
        .describe("Only notes on/after this date (YYYY-MM-DD, Europe/Warsaw calendar day). Omit for no lower bound."),
      until: z
        .string()
        .optional()
        .describe("Only notes on/before this date (YYYY-MM-DD, Europe/Warsaw calendar day). Omit for no upper bound."),
      limit: z.number().int().optional().describe("Max notes to return (default 50)"),
      order: z
        .string()
        .optional()
        .describe("'desc' (default, newest first) or 'asc' (oldest first — use to find the earliest/oldest notes in a range)"),
      project: z.string().optional().describe(PROJECT_DOC),
    }),
    async execute(args, ctx) {
      const since = dateBound(args.since, "since");
      const until = dateBound(args.until, "until");
      if (since === "invalid" || until === "invalid") return "Invalid date — use YYYY-MM-DD.";
      const resolved = await resolveProject(args.project, ctx.msgCtx);
      if (!resolved.ok) return unknownProject(args.project);
      const order = args.order === "asc" ? "asc" : "desc";
      const found = await listNodesByDate(ctx.readableLevels, {
        since,
        until,
        projectId: resolved.id,
        limit: args.limit ?? 50,
        order,
      });
      if (found.length === 0) return "No notes found in that range.";
      const label = order === "asc" ? "oldest first" : "newest first";
      return `Found ${found.length} notes (${label}):\n${found.map((node) => `- ${noteDate(node)} [${node.id}] ${node.content}`).join("\n")}`;
    },
  }),

  get_note: spec({
    description:
      "Fetch a specific note by its UUID. Also returns linked notes for context. Use when you have a note ID from the context and want more details or related notes.",
    inputSchema: z.object({
      id: z.string().describe("UUID of the note to fetch (e.g., '550e8400-e29b-41d4-a716-446655440000')"),
    }),
    async execute({ id }, ctx) {
      const node = await getNodeAccessible(ctx.readableLevels, id);
      if (!node) return `Note not found: ${id}`;
      const linked = await getNodeLinksAccessible(ctx.readableLevels, node.id);
      const linkedContent =
        linked.length === 0
          ? "No linked notes."
          : `Linked notes:\n${linked.map((other) => `- ${noteDate(other)} [${other.id}] ${other.content}`).join("\n")}`;
      return `Note [${node.id}] (${noteDate(node)}):\n${node.content}\n\n${linkedContent}\n`;
    },
  }),

  create_note: spec({
    keepSecretPlaceholders: true,
    description:
      "Flag content for the background memory to save as a note (the memory batch does the actual write, deduplicated with passive capture). Use for facts worth remembering.",
    inputSchema: z.object({ content: z.string().describe("The atomic idea or fact (1-2 sentences)") }),
    async execute({ content }, ctx) {
      const message = flaggable(ctx.msgCtx);
      if (message) {
        await flagMessage(message.channel, message.ts, "create_memory", { content });
        return "Zaznaczyłem do zapamiętania — pamięć w tle zapisze notatkę.";
      }
      let embedding: number[];
      try {
        embedding = await embedQuery(content);
      } catch (error) {
        return `Failed to generate embedding: ${(error as Error).message}`;
      }
      try {
        const node = await createNode(ctx.userId, ctx.writeAccess, { content, embedding });
        return `Created note in slipbox: ${node.id}`;
      } catch (error) {
        return `Failed to create note: ${(error as Error).message}`;
      }
    },
  }),

  delete_note: spec({
    description: "Delete a note from your zettelkasten. All links to/from this note are automatically removed.",
    inputSchema: z.object({ id: z.string().describe("UUID of the note to delete") }),
    async execute({ id }, ctx) {
      const soulMessage = `Note ${id} is a soul and can't be deleted. Change it with update_soul instead.`;
      if (await isSoul(id)) return soulMessage;
      const node = await getNodeAccessible(ctx.readableLevels, id);
      if (!node) return `Note not found: ${id}`;
      const message = flaggable(ctx.msgCtx);
      if (message) {
        await addOp(message.channel, message.ts, { op: "delete", node_id: id, user_id: ctx.userId });
        return `Zaznaczyłem notatkę do usunięcia: ${id}`;
      }
      const result = await deleteNode(ctx.userId, id);
      if (result.ok) return `Deleted note: ${id}`;
      return result.error === "soul" ? soulMessage : `Note not found or not yours: ${id}`;
    },
  }),

  link_notes: spec({
    keepSecretPlaceholders: true,
    description: "Create a link between two notes. Links are undirected - order doesn't matter.",
    inputSchema: z.object({
      note_a_id: z.string().describe("First note UUID"),
      note_b_id: z.string().describe("Second note UUID"),
    }),
    async execute({ note_a_id: a, note_b_id: b }, ctx) {
      const accessible = (await getNodeAccessible(ctx.readableLevels, a)) && (await getNodeAccessible(ctx.readableLevels, b));
      if (!accessible) return "One or both notes not found or not accessible";
      const message = flaggable(ctx.msgCtx);
      if (message) {
        await addOp(message.channel, message.ts, { op: "link", a, b, user_id: ctx.userId });
        return `Zaznaczyłem połączenie notatek: ${a} <-> ${b}`;
      }
      const result = await createLink(ctx.userId, a, b);
      return result.ok ? `Linked ${a} <-> ${b}` : `Failed to create link: ${result.error}`;
    },
  }),

  unlink_notes: spec({
    description: "Remove a link between two notes.",
    inputSchema: z.object({
      note_a_id: z.string().describe("First note UUID"),
      note_b_id: z.string().describe("Second note UUID"),
    }),
    async execute({ note_a_id: a, note_b_id: b }, ctx) {
      const accessible = (await getNodeAccessible(ctx.readableLevels, a)) && (await getNodeAccessible(ctx.readableLevels, b));
      if (!accessible) return "One or both notes not found or not accessible";
      const message = flaggable(ctx.msgCtx);
      if (message) {
        await addOp(message.channel, message.ts, { op: "unlink", a, b, user_id: ctx.userId });
        return `Zaznaczyłem rozłączenie notatek: ${a} <-> ${b}`;
      }
      const link = await deleteLink(ctx.userId, a, b);
      return link ? `Unlinked ${a} <-> ${b}` : `Link not found: ${a} <-> ${b}`;
    },
  }),
};
