import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
if (enabled) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const { db, tables } = await import("../../lib/db/index.ts");
const { deleteSecret, listSecrets, runWithSecrets, setSecret, UnknownSecretError } = await import("../../lib/secrets.ts");
const { findOrCreateBySlackId } = await import("../../lib/accounts.ts");

const NAME = `TEST_${randomUUID().slice(0, 8).toUpperCase()}`;

describe.skipIf(!enabled)("agent secrets", () => {
  let userId: string;

  beforeAll(async () => {
    userId = (await findOrCreateBySlackId(`U${randomUUID().slice(0, 10)}`, `D${randomUUID().slice(0, 10)}`)).id;
    await setSecret(NAME, "s3cr3t-value", "test secret", userId);
  });

  afterAll(async () => {
    await deleteSecret(NAME, userId);
  });

  it("stores the value encrypted and lists only metadata", async () => {
    const [row] = await db
      .select()
      .from(tables.agentSecrets)
      .where((await import("drizzle-orm")).eq(tables.agentSecrets.name, NAME));
    expect(row.value.toString("utf8")).not.toContain("s3cr3t-value");
    const listed = (await listSecrets()).find((secret) => secret.name === NAME);
    expect(listed).toMatchObject({ name: NAME, description: "test secret" });
    expect(listed).not.toHaveProperty("value");
  });

  it("substitutes into tool input and redacts the tool output", async () => {
    let seen: unknown;
    const output = await runWithSecrets({ toolName: "probe", userId }, { arg: `{{ ${NAME} }}` }, async (resolved) => {
      seen = resolved;
      return `got ${resolved.arg}`;
    });
    expect(seen).toEqual({ arg: "s3cr3t-value" });
    expect(output).toBe(`got {{ ${NAME} }}`);
  });

  it("keeps placeholders for tools that store or publish text", async () => {
    let seen: unknown;
    await runWithSecrets({ toolName: "create_note", userId, keepPlaceholders: true }, { content: `{{ ${NAME} }}` }, async (resolved) => {
      seen = resolved;
      return "ok";
    });
    expect(seen).toEqual({ content: `{{ ${NAME} }}` });
  });

  it("rejects unknown placeholders before the tool runs", async () => {
    let ran = false;
    await expect(
      runWithSecrets({ toolName: "probe", userId }, { arg: "{{ NOPE_NOT_THERE }}" }, async () => {
        ran = true;
        return "";
      }),
    ).rejects.toBeInstanceOf(UnknownSecretError);
    expect(ran).toBe(false);
  });

  it("rejects invalid names", async () => {
    await expect(setSecret("lower", "x", null, userId)).rejects.toThrow(/UPPER_SNAKE_CASE/);
  });
});
