import { describe, expect, it } from "vitest";
import { DM_NEEDS_REPLY, NO_REPLY_SENT } from "../../agent/lib/no-reply.ts";

type Tool = {
  execute: (input: unknown, ctx: unknown) => string;
  endsTurn: (output: string) => boolean;
};
const tool = (await import("../../agent/tools/no-reply.ts")).default as unknown as Tool;

const ctx = (channelId: string, kind?: string) => ({
  toolName: "no-reply",
  session: {
    id: "s",
    auth: {
      current: {
        principalId: "kamil",
        attributes: { userId: "kamil", channelId, threadTs: "1800000000.000100", ...(kind ? { kind } : {}) },
      },
      initiator: null,
    },
  },
});

const run = (channelId: string, kind?: string) => {
  const output = tool.execute({ reason: "nothing to add" }, ctx(channelId, kind));
  return { output, ends: tool.endsTurn(output) };
};

describe("no-reply", () => {
  it("does not end a turn in a person's DM and asks for a reply instead", () => {
    expect(run("D1", "slack")).toEqual({ output: DM_NEEDS_REPLY, ends: false });
  });

  it("still ends the turn in a channel thread", () => {
    expect(run("C1", "slack")).toEqual({ output: NO_REPLY_SENT, ends: true });
  });

  it("still ends background runs in a DM", () => {
    for (const kind of ["proactive", "skill_user", "task", "self_review_question"]) {
      expect(run("D1", kind)).toEqual({ output: NO_REPLY_SENT, ends: true });
    }
  });
});
