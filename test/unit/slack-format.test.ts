import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/slack/api.ts", () => ({
  downloadFile: vi.fn(),
  getFileInfo: vi.fn(),
  resolveChannel: vi.fn(),
  fetchUserName: vi.fn(async (id: string) => (id === "U111" ? "Kamil Marczak" : null)),
}));

const { formatMessages } = await import("../../agent/lib/slack.ts");

describe("formatMessages", () => {
  it("keeps Slack IDs next to names so they can be mentioned", async () => {
    const text = await formatMessages([{ user: "U111", text: "hej <@U111> i <@U222>" }]);
    expect(text).toBe("[?] Kamil Marczak <U111>: hej <@U111> (Kamil Marczak) i <@U222>");
  });
});
