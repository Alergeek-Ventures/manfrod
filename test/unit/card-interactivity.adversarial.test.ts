import { beforeEach, describe, expect, it, vi } from "vitest";

const verify = vi.hoisted(() => ({ verifySlackSignature: vi.fn(() => true) }));
vi.mock("../../lib/slack/verify.ts", () => verify);

const { interceptInteractivity } = await import("../../lib/slack/interactivity.ts");

const form = (payload: unknown) => ({
  headers: new Headers({ "content-type": "application/x-www-form-urlencoded" }),
  body: new URLSearchParams({ payload: JSON.stringify(payload) }).toString(),
});

beforeEach(() => {
  verify.verifySlackSignature.mockReturnValue(true);
});

describe("card link click acknowledgement", () => {
  it.each([
    ["no channel or message", { type: "block_actions", user: { id: "U1" }, actions: [{ action_id: "card_link_2", type: "button" }] }],
    ["no user", { type: "block_actions", actions: [{ action_id: "card_link_0" }] }],
    [
      "container thread only",
      { type: "block_actions", user: { id: "U1" }, container: { thread_ts: "1.1" }, actions: [{ action_id: "card_link_4" }] },
    ],
    ["many actions", { type: "block_actions", actions: [{ action_id: "card_link_0" }, { action_id: "card_link_1" }] }],
    ["bare prefix", { type: "block_actions", actions: [{ action_id: "card_link_" }] }],
  ])("returns 200 and resolves for %s", async (_, payload) => {
    const { headers, body } = form(payload);
    const intercepted = interceptInteractivity(headers, body);
    expect(intercepted).not.toBeNull();
    expect(intercepted!.response.status).toBe(200);
    await expect(intercepted!.work).resolves.toBeUndefined();
  });

  it("rejects a forged card click with 401 without doing any work", async () => {
    verify.verifySlackSignature.mockReturnValue(false);
    const { headers, body } = form({ type: "block_actions", actions: [{ action_id: "card_link_0" }] });
    const intercepted = interceptInteractivity(headers, body);
    expect(intercepted!.response.status).toBe(401);
    await expect(intercepted!.work).resolves.toBeUndefined();
  });

  it("does not claim lookalike action ids, other payload types or malformed bodies", () => {
    for (const payload of [
      { type: "block_actions", actions: [{ action_id: "xcard_link_0" }] },
      { type: "block_actions", actions: [{ action_id: "card_link" }] },
      { type: "block_actions", actions: [{ action_id: 5 }] },
      { type: "block_actions", actions: [] },
      { type: "block_actions" },
      { type: "view_submission", view: { callback_id: "card_link_0" } },
    ]) {
      const { headers, body } = form(payload);
      expect(interceptInteractivity(headers, body)).toBeNull();
    }
    expect(interceptInteractivity(new Headers({ "content-type": "application/x-www-form-urlencoded" }), "payload=%7Bnot-json")).toBeNull();
    expect(interceptInteractivity(new Headers({ "content-type": "application/json" }), "{}")).toBeNull();
  });
});
