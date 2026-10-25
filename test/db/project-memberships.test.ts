import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
if (enabled) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const { db, tables } = await import("../../lib/db/index.ts");
const { addMembership, ensureMembership, isMember, removeMembership, resolveForRead } = await import("../../lib/memory/access.ts");
const { findOrCreateBySlackId, setAdmin } = await import("../../lib/accounts.ts");

async function clientProject() {
  const slug = `acme-${randomUUID().slice(0, 6)}`;
  const [project] = await db.insert(tables.projects).values({ slug, name: slug }).returning();
  await db
    .insert(tables.channelMappings)
    .values({ slackChannelId: `C${randomUUID().slice(0, 8)}`, projectId: project.id, clientId: slug, status: "active", source: "manual" });
  return { project, level: `external/${slug}` };
}

describe.skipIf(!enabled)("project memberships", () => {
  it("keeps a removed member out until an admin adds them back", async () => {
    const user = await findOrCreateBySlackId(`U${randomUUID().slice(0, 10)}`, `D${randomUUID().slice(0, 10)}`);
    const { project, level } = await clientProject();

    await ensureMembership(user.id, project.id);
    expect(await resolveForRead(user.id, "D0001")).toContain(level);

    expect(await removeMembership(user.id, project.id)).toBe(true);
    await ensureMembership(user.id, project.id);
    expect(await isMember(user.id, project.id)).toBe(false);
    expect(await resolveForRead(user.id, "D0001")).not.toContain(level);

    await addMembership(user.id, project.id);
    expect(await isMember(user.id, project.id)).toBe(true);
    expect(await resolveForRead(user.id, "D0001")).toContain(level);
  });

  it("lets admins read every client's notes without memberships", async () => {
    const [admin, teammate] = await Promise.all(
      [1, 2].map(() => findOrCreateBySlackId(`U${randomUUID().slice(0, 10)}`, `D${randomUUID().slice(0, 10)}`)),
    );
    const { level } = await clientProject();
    await setAdmin(admin.id, true);
    expect(await resolveForRead(admin.id, "D0001")).toContain(level);
    expect(await resolveForRead(teammate.id, "D0001")).not.toContain(level);
  });
});
