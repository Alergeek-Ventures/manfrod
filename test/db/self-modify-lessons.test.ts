import { describe, expect, it, vi } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
if (enabled) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

vi.mock("../../lib/github.ts", async (original) => ({
  ...(await original<object>()),
  pullCommits: async () => [
    { sha: "a1", message: "feat(tools): add edit-slack-canvas", authorLogin: "manfrod-ai[bot]" },
    { sha: "b2", message: "fix(tools): check membership for canvas IDs", authorLogin: "qamarq" },
  ],
  commitPatch: async (sha: string) => `--- agent/tools/edit-slack-canvas.ts\n+ canvasEditDenial (${sha})`,
}));
const prompts: string[] = [];
vi.mock("../../lib/llm/index.ts", async (original) => ({
  ...(await original<object>()),
  generateText: async (messages: { content: string }[]) => {
    prompts.push(messages.map((message) => message.content).join("\n"));
    return { text: '["A Slack tool given a canvas ID must check membership through the channels it is shared in"]' };
  },
}));

const { learnFromPull, recentLessons } = await import("../../lib/self-modify-lessons.ts");

describe.skipIf(!enabled)("learnFromPull", () => {
  it("turns a person's corrections into a stored lesson", async () => {
    const pullNumber = 800_000 + Math.floor(Math.random() * 99_999);
    expect(await learnFromPull(pullNumber)).toBe(1);
    expect(prompts[0]).toContain("canvasEditDenial (b2)");
    expect(prompts[0]).not.toContain("(a1)");
    const lessons = await recentLessons(5);
    expect(lessons.find((item) => item.pullNumber === pullNumber)?.lesson).toContain("canvas ID");
  });
});
