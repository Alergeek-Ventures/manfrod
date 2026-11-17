import { existsSync, readdirSync, readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({
  createMessage: 0,
  sendEvent: 0,
  broadcast: 0,
  emit: 0,
  streamCardInput: 0,
  mcp: 0,
  linearCreate: 0,
  linearGet: 0,
  secrets: 0,
}));

vi.mock("../../lib/memory/messages.ts", () => ({
  createMessage: async () => {
    calls.createMessage += 1;
  },
}));
vi.mock("../../lib/inngest/client.ts", () => ({
  EVENTS: { sessionActivity: "session.activity" },
  sendEvent: async () => {
    calls.sendEvent += 1;
  },
}));
vi.mock("../../lib/events/index.ts", () => ({
  broadcast: async () => {
    calls.broadcast += 1;
  },
  emit: () => {
    calls.emit += 1;
  },
}));
vi.mock("../../lib/slack/card-stream.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/slack/card-stream.ts")>()),
  streamCardInput: () => {
    calls.streamCardInput += 1;
    return null;
  },
}));
vi.mock("../../lib/secrets.ts", () => ({
  runWithSecrets: (_use: unknown, input: unknown, run: (resolved: unknown) => Promise<unknown>) => {
    calls.secrets += 1;
    return run(input);
  },
}));
vi.mock("../../lib/mcp/tools.ts", () => ({
  listUserMcpTools: async () => [
    {
      name: "gmail__send_email",
      providerId: "gmail",
      remoteName: "send_email",
      host: "gmail.example",
      description: "Send",
      inputSchema: { type: "object" },
    },
  ],
  callUserMcpTool: async () => {
    calls.mcp += 1;
    return "sent";
  },
}));
vi.mock("../../lib/memory/access.ts", () => ({ channelAudience: async () => "internal" }));
vi.mock("../../lib/linear/index.ts", () => ({ getConnection: async () => ({ mode: "app" }) }));
vi.mock("../../lib/linear/calls.ts", () => ({
  commentIssue: async () => "commented",
  createIssue: async () => {
    calls.linearCreate += 1;
    return "created";
  },
  getCycles: async () => "cycles",
  getIssue: async () => {
    calls.linearGet += 1;
    return "issue";
  },
  listIssues: async () => "issues",
  listProjects: async () => "projects",
  searchIssues: async () => "found",
  updateIssue: async () => "updated",
}));
vi.mock("../../agent/lib/linear.ts", () => ({
  linearProjectForChannel: async () => "project-1",
  linearProjectForPerson: async () => ({ ok: true, projectId: "project-1" }),
  linearRequester: async () => null,
}));

const { REHEARSAL_KIND, READ_ONLY_TOOLS, blockedInRehearsal, simulated } = await import("../../lib/rehearsal/guard.ts");
const { defineManfrodTool } = await import("../../agent/lib/define-tool.ts");
const { z } = await import("zod");

const ctxFor = (kind: string, extra: Record<string, string> = {}) => ({
  toolName: "post-slack-message",
  session: {
    id: "session-1",
    auth: { current: { principalId: "user-1", attributes: { userId: "user-1", kind, channelId: "C1", ...extra } }, initiator: null },
  },
  cancel: vi.fn(),
});

type Executable = { execute: (input: unknown, ctx: unknown) => Promise<unknown> };
type Hook = { events: Record<string, (event: unknown, ctx: unknown) => unknown> };

beforeEach(() => {
  for (const key of Object.keys(calls) as (keyof typeof calls)[]) calls[key] = 0;
});

describe("rehearsal guard", () => {
  it("lets only read-only tools run in a rehearsal", () => {
    expect(blockedInRehearsal(REHEARSAL_KIND, "post-slack-message")).toBe(true);
    expect(blockedInRehearsal(REHEARSAL_KIND, "gmail__send_email")).toBe(true);
    expect(blockedInRehearsal(REHEARSAL_KIND, "read-slack-thread")).toBe(false);
    expect(blockedInRehearsal("slack", "post-slack-message")).toBe(false);
    expect(simulated("send-dm", { text: "hi" })).toBe('[rehearsal] not executed: send-dm {"text":"hi"}');
  });

  it("allows only tools that exist and read", () => {
    const linear = ["linear-get-issue", "linear-list-cycles", "linear-list-issues", "linear-list-projects", "linear-search-issues"];
    for (const name of READ_ONLY_TOOLS) {
      if (linear.includes(name)) continue;
      expect(existsSync(`agent/tools/${name}.ts`), name).toBe(true);
    }
    for (const name of [
      "send-dm",
      "post-slack-message",
      "show-card",
      "http-request",
      "set-reminder",
      "reserve-desk",
      "create-task",
      "create-note",
    ]) {
      expect(READ_ONLY_TOOLS.has(name), name).toBe(false);
    }
  });

  it("covers every tool source the main agent has", () => {
    expect(readFileSync("agent/agent.ts", "utf8")).toContain("defaultTools: false");
    expect(existsSync("agent/connections")).toBe(false);
    for (const file of readdirSync("agent/tools")) {
      const source = readFileSync(`agent/tools/${file}`, "utf8");
      if (file === "integrations.ts") expect(source).toContain("runGuarded(kind, ");
      else if (file === "no-reply.ts") expect(source).toContain("eve/tools/no_reply");
      else expect(source, file).toContain("defineManfrodTool(");
    }
    expect(readFileSync("agent/tools/integrations.ts", "utf8")).not.toContain("runWithSecrets(");
    expect(readdirSync("agent/subagents").sort()).toEqual(["advisor", "self-modify"]);
    expect(readdirSync("agent/subagents/advisor").sort()).toEqual(["agent.ts", "instructions.md"]);
    expect(readFileSync("agent/subagents/advisor/agent.ts", "utf8")).toContain("defaultTools: false");
    expect(readFileSync("agent/channels/jobs.ts", "utf8")).not.toMatch(/^\s*events\s*:\s*\{/m);
  });
});

describe("authored tools in a rehearsal", () => {
  const tool = defineManfrodTool({
    description: "test",
    inputSchema: z.object({ text: z.string() }),
    execute: async () => "really executed",
  }) as unknown as Executable;

  it("return a simulated result instead of running", async () => {
    expect(await tool.execute({ text: "hi" }, ctxFor(REHEARSAL_KIND))).toBe('[rehearsal] not executed: post-slack-message {"text":"hi"}');
    expect(calls.secrets).toBe(0);
  });

  it("run normally outside a rehearsal and for read-only tools", async () => {
    expect(await tool.execute({ text: "hi" }, ctxFor("slack"))).toBe("really executed");
    expect(await tool.execute({ text: "hi" }, { ...ctxFor(REHEARSAL_KIND), toolName: "read-slack-thread" })).toBe("really executed");
  });
});

describe("MCP and Linear tools in a rehearsal", () => {
  it("simulate writes and keep reads", async () => {
    const resolver = (await import("../../agent/tools/integrations.ts")).default as unknown as Hook;
    const entries = (await resolver.events["turn.started"]({}, ctxFor(REHEARSAL_KIND))) as Record<string, Executable>;
    expect(await entries["gmail__send_email"].execute({ to: "x" }, {})).toContain("[rehearsal] not executed: gmail__send_email");
    expect(await entries["linear-create-issue"].execute({ title: "x" }, {})).toContain("[rehearsal] not executed: linear-create-issue");
    expect(await entries["linear-get-issue"].execute({ identifier: "ENG-1" }, {})).toBe("issue");
    expect(calls.mcp).toBe(0);
    expect(calls.linearCreate).toBe(0);
    expect(calls.linearGet).toBe(1);
  });

  it("run for real outside a rehearsal", async () => {
    const resolver = (await import("../../agent/tools/integrations.ts")).default as unknown as Hook;
    const entries = (await resolver.events["turn.started"]({}, ctxFor("slack"))) as Record<string, Executable>;
    expect(await entries["gmail__send_email"].execute({ to: "x" }, {})).toBe("sent");
  });
});

describe("hooks in a rehearsal", () => {
  it("don't persist messages, start memory extraction or write audit events", async () => {
    const audit = (await import("../../agent/hooks/audit.ts")).default as unknown as Hook;
    const ctx = ctxFor(REHEARSAL_KIND, { threadTs: "1.0" });
    await audit.events["turn.started"]({}, ctx);
    await audit.events["actions.requested"]({ data: { actions: [{ callId: "c1", toolName: "send-dm", input: {} }] } }, ctx);
    await audit.events["message.completed"]({ data: { message: "reply", finishReason: "stop" } }, ctx);
    await audit.events["turn.completed"]({}, ctx);
    expect(calls).toMatchObject({ createMessage: 0, sendEvent: 0, broadcast: 0, emit: 0 });
  });

  it("still record ordinary Slack turns", async () => {
    const audit = (await import("../../agent/hooks/audit.ts")).default as unknown as Hook;
    await audit.events["message.completed"]({ data: { message: "reply", finishReason: "stop" } }, ctxFor("slack", { threadTs: "1.0" }));
    expect(calls.createMessage).toBe(1);
    expect(calls.sendEvent).toBe(1);
  });

  it("never stream cards to Slack", async () => {
    const cards = (await import("../../agent/hooks/card-stream.ts")).default as unknown as Hook;
    const event = { data: { toolName: "show-card", callId: "c1", inputTextDelta: "{", turnId: "t1" } };
    cards.events["action.input.appended"](event, ctxFor(REHEARSAL_KIND, { threadTs: "1.0" }));
    expect(calls.streamCardInput).toBe(0);
    cards.events["action.input.appended"](event, ctxFor("slack", { threadTs: "1.0" }));
    expect(calls.streamCardInput).toBe(1);
  });

  it("cancel the self-modify subagent before it does anything", async () => {
    const hook = (await import("../../agent/subagents/self-modify/hooks/rehearsal.ts")).default as unknown as Hook;
    const rehearsal = ctxFor(REHEARSAL_KIND);
    hook.events["turn.started"]({}, rehearsal);
    expect(rehearsal.cancel).toHaveBeenCalledOnce();
    const ordinary = ctxFor("self_review");
    hook.events["turn.started"]({}, ordinary);
    expect(ordinary.cancel).not.toHaveBeenCalled();
  });

  it("refuse self-modify tools", async () => {
    const { authorize } = await import("../../agent/lib/self-modify.ts");
    const { toolCtx } = await import("../../lib/agent/context.ts");
    expect(await authorize(toolCtx(ctxFor(REHEARSAL_KIND)))).toBe("Self-modify does not run in a rehearsal.");
  });
});
