import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { clearLookupCache, MEMBERS_FAILURE_TTL_MS, workspaceMembers } from "../../lib/slack/api.ts";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

const ok = (members: Record<string, unknown>[]) => ({ status: 200, json: async () => ({ ok: true, members }) });

beforeEach(() => {
  fetchMock.mockReset();
  clearLookupCache();
  vi.useRealTimers();
});

afterAll(() => vi.unstubAllGlobals());

describe("workspaceMembers", () => {
  it("shares one users.list sweep between parallel lookups and reads guest and team flags", async () => {
    fetchMock.mockImplementation(async () =>
      ok([{ id: "U1", name: "ala", real_name: "Ala", team_id: "T1", is_restricted: true, is_stranger: false, profile: {} }]),
    );
    const [first, second] = await Promise.all([workspaceMembers(), workspaceMembers()]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(first?.[0]).toMatchObject({ id: "U1", restricted: true, ultraRestricted: false, stranger: false, teamId: "T1" });
  });

  it("remembers a failed sweep for a short while", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    fetchMock.mockImplementation(async () => ({ status: 200, json: async () => ({ ok: false, error: "ratelimited" }) }));
    expect(await workspaceMembers()).toBeNull();
    expect(await workspaceMembers()).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now() + MEMBERS_FAILURE_TTL_MS + 1);
    fetchMock.mockImplementation(async () => ok([]));
    expect(await workspaceMembers()).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
