import { beforeEach, describe, expect, it, vi } from "vitest";

const slack = vi.hoisted(() => ({
  getFileInfo: vi.fn(),
  channelMembers: vi.fn(),
}));
vi.mock("../../lib/slack/api.ts", async (original) => ({ ...(await original<object>()), ...slack }));

const { canvasEditDenial } = await import("../../agent/lib/slack.ts");

const person = { slackId: "U1", name: "Ala" };

describe("canvasEditDenial", () => {
  beforeEach(() => {
    slack.getFileInfo.mockReset();
    slack.channelMembers.mockReset();
  });

  it("allows a channel canvas when the person is a member", async () => {
    slack.channelMembers.mockResolvedValue(["U1"]);
    expect(await canvasEditDenial({ id: "F1", channelId: "C1" }, person)).toBeNull();
  });

  it("refuses a channel canvas when the person is not a member", async () => {
    slack.channelMembers.mockResolvedValue(["U2"]);
    expect(await canvasEditDenial({ id: "F1", channelId: "C1" }, person)).toContain("not a member of <#C1>");
  });

  it("refuses canvases in direct messages", async () => {
    expect(await canvasEditDenial({ id: "F1", channelId: "D1" }, person)).toContain("direct messages");
    expect(slack.channelMembers).not.toHaveBeenCalled();
  });

  it("checks the channels a canvas given by ID is shared in", async () => {
    slack.getFileInfo.mockResolvedValue({ channels: ["C1"], shares: { private: { G2: [] } } });
    slack.channelMembers.mockImplementation(async (channel: string) => (channel === "G2" ? ["U1"] : ["U9"]));
    expect(await canvasEditDenial({ id: "F1", channelId: null }, person)).toBeNull();
  });

  it("refuses a canvas given by ID in a private channel the person is not in", async () => {
    slack.getFileInfo.mockResolvedValue({ shares: { private: { G2: [] } } });
    slack.channelMembers.mockResolvedValue(["U9"]);
    expect(await canvasEditDenial({ id: "F1", channelId: null }, person)).toContain("not a member of <#G2>");
  });

  it("refuses a canvas given by ID that is not shared in any channel or only in a DM", async () => {
    slack.getFileInfo.mockResolvedValue({ shares: { private: { D3: [] } } });
    expect(await canvasEditDenial({ id: "F1", channelId: null }, person)).toContain("isn't shared in any channel");
    slack.getFileInfo.mockResolvedValue(null);
    expect(await canvasEditDenial({ id: "F1", channelId: null }, person)).toContain("Could not read the canvas details");
  });
});
