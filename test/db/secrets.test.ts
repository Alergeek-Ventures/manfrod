import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
if (enabled) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const { db, tables } = await import("../../lib/db/index.ts");
const { deleteSecret, listSecretsFor, runWithSecrets, saveSecret, SecretUseError } = await import("../../lib/secrets.ts");
const { findOrCreateBySlackId } = await import("../../lib/accounts.ts");
const { eq } = await import("drizzle-orm");

const NAME = `TEST_${randomUUID().slice(0, 8).toUpperCase()}`;

describe.skipIf(!enabled)("agent secrets", () => {
  let owner: Awaited<ReturnType<typeof findOrCreateBySlackId>>;
  let other: Awaited<ReturnType<typeof findOrCreateBySlackId>>;

  beforeAll(async () => {
    owner = await findOrCreateBySlackId(`U${randomUUID().slice(0, 10)}`, `D${randomUUID().slice(0, 10)}`);
    other = await findOrCreateBySlackId(`U${randomUUID().slice(0, 10)}`, `D${randomUUID().slice(0, 10)}`);
    await saveSecret(owner, {
      name: NAME,
      value: "s3cr3t-value",
      description: "test secret",
      scope: "personal",
      allowedHosts: ["api.example.com"],
    });
  });

  afterAll(async () => {
    const mine = (await listSecretsFor(owner)).find((secret) => secret.name === NAME);
    if (mine) await deleteSecret(owner, mine.id);
  });

  it("stores the value encrypted and lists only metadata to its owner", async () => {
    const [row] = await db.select().from(tables.agentSecrets).where(eq(tables.agentSecrets.name, NAME));
    expect(row.value.toString("utf8")).not.toContain("s3cr3t-value");
    const listed = (await listSecretsFor(owner)).find((secret) => secret.name === NAME);
    expect(listed).toMatchObject({ name: NAME, description: "test secret", scope: "personal", allowedHosts: ["api.example.com"] });
    expect(listed).not.toHaveProperty("value");
    expect((await listSecretsFor(other)).some((secret) => secret.name === NAME)).toBe(false);
  });

  it("substitutes for its owner on an allowed host and redacts the output", async () => {
    let seen: unknown;
    const output = await runWithSecrets(
      { toolName: "probe", userId: owner.id, destinationHost: "api.example.com" },
      { arg: `{{ ${NAME} }}` },
      async (resolved) => {
        seen = resolved;
        return `got ${resolved.arg}`;
      },
    );
    expect(seen).toEqual({ arg: "s3cr3t-value" });
    expect(output).toBe(`got {{ ${NAME} }}`);
  });

  it("refuses other people, other hosts and tools without a destination", async () => {
    const run = (userId: string, destinationHost: string | null) =>
      runWithSecrets({ toolName: "probe", userId, destinationHost }, { arg: `{{ ${NAME} }}` }, async (resolved) => resolved.arg);
    await expect(run(other.id, "api.example.com")).rejects.toBeInstanceOf(SecretUseError);
    await expect(run(owner.id, "evil.com")).rejects.toBeInstanceOf(SecretUseError);
    expect(await run(owner.id, null)).toBe(`{{ ${NAME} }}`);
  });

  it("lets only admins add company secrets and owners delete their own", async () => {
    await expect(
      saveSecret(owner, { name: `${NAME}_CO`, value: "x", description: null, scope: "company", allowedHosts: ["a.com"] }),
    ).rejects.toThrow(/Only admins/);
    const mine = (await listSecretsFor(owner)).find((secret) => secret.name === NAME)!;
    await expect(deleteSecret(other, mine.id)).rejects.toThrow(/your own/);
  });
});
