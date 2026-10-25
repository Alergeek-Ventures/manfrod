import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
if (enabled) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const generateText = vi.fn();
vi.mock("../../lib/llm/index.ts", async (original) => ({ ...(await original<object>()), generateText }));
vi.mock("../../lib/voyage.ts", () => ({ embedQuery: async () => Array.from({ length: 1024 }, () => 0.1) }));

const { findOrCreateBySlackId } = await import("../../lib/accounts.ts");
const { privateLevel } = await import("../../lib/memory/access.ts");
const { createMessage } = await import("../../lib/memory/messages.ts");
const { getSoul } = await import("../../lib/memory/nodes.ts");
const { needsWelcomeSoul, welcomeSoulAfterConversation, welcomeTranscript } = await import("../../lib/memory/souls.ts");

const HOUR = 3_600_000;
const insertUser = () => findOrCreateBySlackId(`U${randomUUID().slice(0, 10)}`, `D${randomUUID().slice(0, 10)}`);
const say = (userId: string, sessionKey: string, role: "user" | "assistant", content: string, receivedAt: Date) =>
  createMessage(userId, { role, content, sessionKey, receivedAt });

describe.skipIf(!enabled)("welcome souls", () => {
  beforeEach(() => generateText.mockReset());

  it("reads only the first DM thread", async () => {
    const user = await insertUser();
    const start = new Date(Date.UTC(2026, 6, 16, 6));
    await say(user.id, "D1:1", "user", "jestem fullstack programista", start);
    await say(user.id, "D1:1", "assistant", "super, jak mam do ciebie mowic?", new Date(start.getTime() + HOUR));
    await say(user.id, "C1:1", "user", "deploy na piatek", new Date(start.getTime() + 2 * HOUR));
    await say(user.id, "D1:2", "user", "przypomnij mi o spotkaniu", new Date(start.getTime() + 3 * HOUR));
    await say(user.id, "D1:1", "user", "mow do mnie luzno", new Date(start.getTime() + 30 * HOUR));

    const transcript = await welcomeTranscript(user.id);
    expect(transcript).toContain("Person: jestem fullstack programista");
    expect(transcript).toContain("Manfrod: super");
    expect(transcript).toContain("Person: mow do mnie luzno");
    expect(transcript).not.toContain("deploy");
    expect(transcript).not.toContain("spotkaniu");
  });

  it("saves a private soul after the first DM thread of a user without one", async () => {
    const user = await insertUser();
    await say(user.id, "D1:1", "user", "mow do mnie luzno", new Date());
    generateText.mockResolvedValue({ text: "Jestem luźnym kumplem Oli." });

    const soul = await welcomeSoulAfterConversation(user.id, "Ola", "D1:1");
    expect(soul?.access).toEqual([privateLevel(user.id)]);
    expect((await getSoul(user.id))?.content).toBe("Jestem luźnym kumplem Oli.");
    expect(await needsWelcomeSoul(user.id)).toBe(false);

    expect(await welcomeSoulAfterConversation(user.id, "Ola", "D1:1")).toBeNull();
    expect(generateText).toHaveBeenCalledOnce();
  });

  it("leaves users alone in later threads or when they shared nothing", async () => {
    const user = await insertUser();
    await say(user.id, "D1:1", "user", "siema", new Date(Date.now() - HOUR));
    await say(user.id, "D1:2", "user", "jestem Ola", new Date());
    expect(await welcomeSoulAfterConversation(user.id, null, "D1:2")).toBeNull();
    expect(generateText).not.toHaveBeenCalled();

    generateText.mockResolvedValue({ text: "NONE" });
    expect(await welcomeSoulAfterConversation(user.id, null, "D1:1")).toBeNull();
    expect(await getSoul(user.id)).toBeNull();
  });
});
