import { z } from "zod";
import { getUser, getUserBySlackId, isSystemUser, listUsers } from "../../lib/accounts.ts";
import { getSoul } from "../../lib/memory/nodes.ts";
import { defineManfrodTool } from "../lib/define-tool.ts";

async function findPeople(person: string) {
  const needle = person.trim();
  const exact = (await getUserBySlackId(needle)) ?? (await getUser(needle));
  if (exact) return [exact];
  const lowered = needle.toLowerCase();
  return (await listUsers()).filter((user) => !isSystemUser(user) && (user.name ?? "").toLowerCase().includes(lowered));
}

export default defineManfrodTool({
  description:
    "Read a teammate's soul for work background: their role and position in the company, what they work on and are responsible for, and how they prefer to work. Use it in team channels and DMs, together with search-notes, when you need that context on a specific person. Use only the work-relevant parts: leave out hobbies, personal interests, private matters and how they like you to talk to them, and never paste the soul into the conversation.",
  inputSchema: z.object({ person: z.string().describe("Slack user ID (e.g. U0123ABCD), Manfrod user ID, or the person's name") }),
  async execute({ person }, ctx) {
    if (!ctx.readableLevels.includes("internal")) return "Teammates' souls are only available in team channels and DMs.";
    const people = await findPeople(person);
    if (people.length === 0) return `No teammate found for "${person}".`;
    if (people.length > 1)
      return `"${person}" matches several people: ${people.map((user) => `${user.name} (${user.slackId})`).join(", ")}. Pass a Slack ID.`;
    const [user] = people;
    const soul = await getSoul(user.id);
    return soul
      ? `Soul of ${user.name ?? user.slackId} (use only the work-relevant parts):\n${soul.content}`
      : `${user.name ?? user.slackId} has no soul yet.`;
  },
});
