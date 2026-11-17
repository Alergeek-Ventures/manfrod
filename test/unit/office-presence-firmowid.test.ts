import { beforeEach, describe, expect, it, vi } from "vitest";

const mcp = vi.hoisted(() => ({ callTool: vi.fn() }));
const signals = vi.hoisted(() => ({ firmowidAccess: vi.fn(async () => ({ mcpUrl: "https://firmowid.test/mcp", token: "t" })) }));

vi.mock("../../lib/mcp/client.ts", () => mcp);
vi.mock("../../lib/nudges/signals.ts", () => signals);

const { clearFirmowidCache, fetchFirmowidSignals } = await import("../../lib/office/presence-firmowid.ts");

const sessions = { structuredContent: { records: [{ is_remote: false, start_datetime: "2026-11-16T08:00:00Z" }] } };
const leaves = { structuredContent: { records: [{ starts_on: "2026-11-18", ends_on: "2026-11-18", status: "approved" }] } };

beforeEach(() => {
  clearFirmowidCache();
  mcp.callTool.mockReset();
  mcp.callTool.mockImplementation(async (_url: string, _token: string, tool: string) => ({
    ok: true,
    value: tool === "list_sessions" ? sessions : leaves,
  }));
});

describe("Firmowid presence signals cache", () => {
  it("asks Firmowid once per person and date window", async () => {
    const first = await fetchFirmowidSignals("u1", "2026-10-01", "2026-11-18");
    const second = await fetchFirmowidSignals("u1", "2026-10-01", "2026-11-18");
    expect(second).toEqual(first);
    expect(mcp.callTool).toHaveBeenCalledTimes(2);
    await fetchFirmowidSignals("u2", "2026-10-01", "2026-11-18");
    await fetchFirmowidSignals("u1", "2026-10-01", "2026-11-19");
    expect(mcp.callTool).toHaveBeenCalledTimes(5);
    expect(mcp.callTool).toHaveBeenLastCalledWith(expect.any(String), "t", "list_leave_requests", {
      input: { start_date: "2026-11-19", end_date: "2026-11-19" },
    });
  });

  it("does not cache failures", async () => {
    mcp.callTool.mockResolvedValueOnce({ ok: false, error: "boom" }).mockResolvedValueOnce({ ok: false, error: "boom" });
    expect(await fetchFirmowidSignals("u1", "2026-10-01", "2026-11-18")).toEqual({ sessionDays: null, leaveRequests: null });
    const retried = await fetchFirmowidSignals("u1", "2026-10-01", "2026-11-18");
    expect(retried.leaveRequests).toHaveLength(1);
    expect(mcp.callTool).toHaveBeenCalledTimes(4);
  });

  it("expires after fifteen minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      await fetchFirmowidSignals("u1", "2026-10-01", "2026-11-18");
      vi.setSystemTime(Date.now() + 16 * 60_000);
      await fetchFirmowidSignals("u1", "2026-10-01", "2026-11-18");
      expect(mcp.callTool).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });
});
