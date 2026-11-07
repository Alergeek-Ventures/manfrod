import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/slack/verify.ts", () => ({ verifySlackSignature: vi.fn(() => true) }));

const { interceptInteractivity } = await import("../../lib/slack/interactivity.ts");

const request = (payload: unknown) => ({
  headers: new Headers({ "content-type": "application/x-www-form-urlencoded" }),
  body: new URLSearchParams({ payload: JSON.stringify(payload) }).toString(),
});

describe("card link buttons", () => {
  it("acknowledges a click without starting a turn", async () => {
    const { headers, body } = request({
      type: "block_actions",
      user: { id: "U1" },
      channel: { id: "C1" },
      message: { ts: "1.2", thread_ts: "1.1" },
      actions: [{ action_id: "card_link_0", type: "button", url: "https://example.com" }],
    });
    const intercepted = interceptInteractivity(headers, body);
    expect(intercepted).not.toBeNull();
    expect(intercepted!.response.status).toBe(200);
    await expect(intercepted!.work).resolves.toBeUndefined();
  });

  it("leaves card reply clicks to eve so they reach the channel's onInteraction", () => {
    const { headers, body } = request({
      type: "block_actions",
      user: { id: "U1" },
      channel: { id: "C1" },
      message: { ts: "1.2", thread_ts: "1.1" },
      actions: [{ action_id: "card_reply_0", type: "button", value: "Pokaż szczegóły" }],
    });
    expect(interceptInteractivity(headers, body)).toBeNull();
  });

  it("leaves other actions to eve", () => {
    const { headers, body } = request({ type: "block_actions", actions: [{ action_id: "something_else" }] });
    expect(interceptInteractivity(headers, body)).toBeNull();
  });
});
