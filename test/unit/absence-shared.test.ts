import { beforeEach, describe, expect, it, vi } from "vitest";

const pending = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
const sendEvent = vi.hoisted(() => vi.fn(async () => true));

vi.mock("../../lib/memory/pending.ts", () => ({
  getConfirmation: vi.fn(async () => (pending.current ? { channelId: "D1", payload: pending.current } : null)),
  deleteConfirmation: vi.fn(),
  putConfirmation: vi.fn(),
  peek: vi.fn(),
  take: vi.fn(),
}));
vi.mock("../../lib/slack/api.ts", () => ({ post: vi.fn(async () => ({ ok: true, body: {} })) }));
vi.mock("../../lib/inngest/client.ts", () => ({ EVENTS: { absenceShared: "manfrod/absence.shared" }, sendEvent }));
vi.mock("../../lib/memory/nodes.ts", () => ({ escalateNoteAccess: vi.fn(async () => ({ ok: true })) }));
vi.mock("../../lib/facts.ts", () => ({ addAccess: vi.fn() }));

const { resolveEscalation } = await import("../../lib/memory/classifier.ts");

const absence = { userId: "u1", startDate: "2026-11-02", endDate: "2026-11-06", working: false, details: "urlop" };
const payload = (extra: Record<string, unknown>) => ({
  node_id: "n1",
  options: ["internal", "external/all"],
  preselected: ["internal", "external/all"],
  write_access: ["private/u1"],
  fact_key: "absence:u1:2026-11-02",
  lang: "pl",
  author_slack_id: "U1",
  ...extra,
});
const clicker = { slackUserId: "U1", threadTs: undefined };

describe("resolveEscalation", () => {
  beforeEach(() => sendEvent.mockClear());

  it("starts the absence follow-up once the author picks who sees it", async () => {
    pending.current = payload({ absence });
    await resolveEscalation("save", ["internal"], "D1", "1.0", clicker);
    expect(sendEvent).toHaveBeenCalledWith("manfrod/absence.shared", absence);
  });

  it("starts it when the author keeps the absence private too", async () => {
    pending.current = payload({ absence });
    await resolveEscalation("cancel", [], "D1", "1.0", clicker);
    expect(sendEvent).toHaveBeenCalledWith("manfrod/absence.shared", absence);
  });

  it("does not start it for an ordinary note or someone else's click", async () => {
    pending.current = payload({});
    await resolveEscalation("save", ["internal"], "D1", "1.0", clicker);
    pending.current = payload({ absence });
    await resolveEscalation("save", ["internal"], "D1", "1.0", { slackUserId: "U2", threadTs: undefined });
    expect(sendEvent).not.toHaveBeenCalled();
  });
});
