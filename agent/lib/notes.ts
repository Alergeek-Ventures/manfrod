import type { Node } from "../../lib/db/schema.ts";
import { projectIdForChannel } from "../../lib/memory/access.ts";
import { findProject } from "../../lib/memory/projects.ts";
import { dateIsoInZone, isValidIsoDate, zonedToUtc } from "../../lib/time.ts";
import { type MsgCtx } from "../../lib/../lib/agent/context.ts";

export const PROJECT_DOC =
  "Project name or slug to scope results to (use list-projects to confirm/disambiguate first if unsure). Omit to use the current channel's project, if this channel is mapped to one — otherwise no project scoping is applied.";

export const noteDate = (node: Node) => dateIsoInZone(node.insertedAt);

export const unknownProject = (name: string | undefined) => `Nie znalazłem projektu "${name}" — sprawdź listę przez list-projects.`;

export async function resolveProject(name: string | undefined, msgCtx: MsgCtx): Promise<{ ok: true; id: string | null } | { ok: false }> {
  if (name === undefined || name === null || name === "") {
    return { ok: true, id: msgCtx.channel ? await projectIdForChannel(msgCtx.channel) : null };
  }
  const project = await findProject(name);
  return project ? { ok: true, id: project.id } : { ok: false };
}

export function dateBound(value: string | undefined, edge: "since" | "until"): Date | null | "invalid" {
  if (value === undefined || value === null) return null;
  if (!isValidIsoDate(value)) return "invalid";
  return zonedToUtc(value, edge === "since" ? "00:00:00" : "23:59:59");
}
