import { describe, expect, it, vi } from "vitest";

vi.mock("../../lib/slack/verify.ts", () => ({ verifySlackSignature: vi.fn(() => true) }));

const { interceptInteractivity } = await import("../../lib/slack/interactivity.ts");

const request = (payload: unknown) => ({
  headers: new Headers({ "content-type": "application/x-www-form-urlencoded" }),
  body: new URLSearchParams({ payload: JSON.stringify(payload) }).toString(),
});

const withAction = (actionId: string) =>
  request({
    type: "block_actions",
    user: { id: "U1" },
    channel: { id: "C1" },
    message: { ts: "1.2", thread_ts: "1.1" },
    actions: [{ action_id: actionId, type: "button", value: "v" }],
  });

describe("adversarial: interactivity routing with card actions", () => {
  it.each(["card_link_0", "card_link_4", "manfrod_feedback", "manfrod_feedback_remove", "capability_approve", "capability_reject"])(
    "still intercepts %s",
    (actionId) => {
      const { headers, body } = withAction(actionId);
      expect(interceptInteractivity(headers, body)).not.toBeNull();
    },
  );

  it.each(["card_reply_0", "card_reply_x", "card_reply_", "card_replyX", "unknown"])("leaves %s to eve", (actionId) => {
    const { headers, body } = withAction(actionId);
    expect(interceptInteractivity(headers, body)).toBeNull();
  });

  it("does not intercept a reply click whose payload is not form encoded or is malformed", () => {
    expect(interceptInteractivity(new Headers({ "content-type": "application/json" }), "{}")).toBeNull();
    expect(interceptInteractivity(new Headers({ "content-type": "application/x-www-form-urlencoded" }), "payload=%7Bnot-json")).toBeNull();
  });
});
