import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  notes: new Map<string, { id: string; userId: string; access: string[] }>(),
  souls: new Set<string>(),
}));

const nodes = vi.hoisted(() => ({
  isSoul: vi.fn(async (id: string) => store.souls.has(id)),
  getNodeAccessible: vi.fn(async (levels: string[], id: string) => {
    const node = store.notes.get(id);
    return node && node.access.some((level) => levels.includes(level)) ? node : null;
  }),
  canModify: (node: { userId: string }, actor: { userId: string; readableLevels: string[] }) =>
    node.userId === actor.userId || actor.readableLevels.includes("internal"),
  deleteNodeAs: vi.fn(async () => ({ ok: true })),
  createNode: vi.fn(async () => ({ id: "new-note" })),
}));
const pending = vi.hoisted(() => ({ addOp: vi.fn(async () => {}), flagMessage: vi.fn(async () => {}) }));

vi.mock("../../lib/memory/nodes.ts", () => nodes);
vi.mock("../../lib/memory/pending.ts", () => pending);
vi.mock("../../lib/voyage.ts", () => ({ embedQuery: async () => [0.1] }));
vi.mock("../../lib/secrets.ts", () => ({
  runWithSecrets: (_use: unknown, input: unknown, run: (resolved: unknown) => Promise<unknown>) => run(input),
}));

type Tool = { execute: (input: unknown, ctx: unknown) => Promise<string>; description: string };
const deleteNote = (await import("../../agent/tools/delete-note.ts")).default as unknown as Tool;
const createNote = (await import("../../agent/tools/create-note.ts")).default as unknown as Tool;

const ctx = (readableLevels: string[], messageTs: string | null = "1800000000.000100", channel = "D1") => ({
  toolName: "delete-note",
  session: {
    id: "s",
    auth: {
      current: {
        principalId: "kamil",
        attributes: {
          userId: "kamil",
          kind: "slack",
          readableLevels,
          writeAccess: ["private/kamil"],
          channelId: channel,
          threadTs: "1800000000.000100",
          ...(messageTs ? { messageTs } : {}),
        },
      },
      initiator: null,
    },
  },
});

const DM = ["private/kamil", "internal", "external/all"];

beforeEach(() => {
  vi.clearAllMocks();
  store.notes = new Map([
    ["mine", { id: "mine", userId: "kamil", access: ["private/kamil"] }],
    ["team", { id: "team", userId: "bartosz", access: ["internal"] }],
    ["acme", { id: "acme", userId: "bartosz", access: ["external/acme"] }],
    ["other-private", { id: "other-private", userId: "bartosz", access: ["private/bartosz"] }],
  ]);
  store.souls = new Set(["soul"]);
  store.notes.set("soul", { id: "soul", userId: "kamil", access: ["private/kamil"] });
});

describe("delete-note", () => {
  it("queues the deletion and tells the model not to claim it is done", async () => {
    const result = await deleteNote.execute({ id: "mine" }, ctx(DM));
    expect(pending.addOp).toHaveBeenCalledWith("D1", "1800000000.000100", {
      op: "delete",
      node_id: "mine",
      user_id: "kamil",
      readable_levels: DM,
    });
    expect(result).toContain("Queued note mine for deletion");
    expect(result).toContain("not that it is already deleted");
    expect(result).not.toMatch(/^Deleted/);
    expect(nodes.deleteNodeAs).not.toHaveBeenCalled();
  });

  it("deletes right away only when there is no message to attach the op to", async () => {
    expect(await deleteNote.execute({ id: "mine" }, ctx(DM, null))).toBe("Deleted note: mine");
    expect(nodes.deleteNodeAs).toHaveBeenCalledWith({ userId: "kamil", readableLevels: DM }, "mine");
  });

  it("refuses another person's private note it cannot read", async () => {
    expect(await deleteNote.execute({ id: "other-private" }, ctx(DM))).toBe("Note not found: other-private");
    expect(pending.addOp).not.toHaveBeenCalled();
  });

  it("refuses someone else's note in a client channel", async () => {
    expect(await deleteNote.execute({ id: "acme" }, ctx(["external/acme", "external/all"], undefined, "C1"))).toContain(
      "only delete your own notes",
    );
    expect(pending.addOp).not.toHaveBeenCalled();
  });

  it("refuses a soul", async () => {
    expect(await deleteNote.execute({ id: "soul" }, ctx(DM))).toContain("is a soul");
    expect(pending.addOp).not.toHaveBeenCalled();
  });

  it("tells the model to delete only what was asked and not move others' data", () => {
    expect(deleteNote.description).toContain("Delete only what the person asked for");
    expect(deleteNote.description).toContain("ask first");
    expect(deleteNote.description).toContain("Never move another person's details");
  });
});

describe("create-note", () => {
  it("queues the note and tells the model it does not exist yet", async () => {
    const result = await createNote.execute({ content: "Kamil prefers short replies." }, ctx(DM));
    expect(pending.flagMessage).toHaveBeenCalledWith("D1", "1800000000.000100", "create_memory", {
      content: "Kamil prefers short replies.",
    });
    expect(result).toContain("doesn't exist yet");
    expect(nodes.createNode).not.toHaveBeenCalled();
  });

  it("tells the model not to copy another person's details or re-save deleted leftovers", () => {
    expect(createNote.description).toContain("never copy another person's details");
    expect(createNote.description).toContain("note you were asked to delete");
  });
});
