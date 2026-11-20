import { beforeEach, describe, expect, it, vi } from "vitest";

const desks = vi.hoisted(() => ({ cancelReservationsForDate: vi.fn(async () => [] as string[]) }));
const plan = vi.hoisted(() => ({ refreshPlans: vi.fn(async (dates: string[]) => dates) }));
const store = vi.hoisted(() => ({ setChatPresence: vi.fn(async (_userId: string, _date: string, _status: string) => true) }));

vi.mock("../../lib/desks.ts", () => desks);
vi.mock("../../lib/office/plan.ts", () => plan);
vi.mock("../../lib/office/presence-store.ts", () => store);

const { recordChatPresence, releaseAwayDays } = await import("../../lib/office/chat-presence.ts");

const TODAY = "2026-11-17";

beforeEach(() => vi.clearAllMocks());

describe("presence said in chat", () => {
  it("records days from today on and refreshes the plans without touching desk bookings", async () => {
    await recordChatPresence("ala", ["2026-11-16", TODAY, "2026-11-18"], "remote", TODAY);
    expect(store.setChatPresence.mock.calls).toEqual([
      ["ala", TODAY, "remote"],
      ["ala", "2026-11-18", "remote"],
    ]);
    expect(desks.cancelReservationsForDate).not.toHaveBeenCalled();
    expect(plan.refreshPlans).toHaveBeenCalledWith([TODAY, "2026-11-18"]);
  });

  it("refreshes only the days it could record", async () => {
    store.setChatPresence.mockImplementation(async (_userId, date) => date !== TODAY);
    await recordChatPresence("ala", [TODAY, "2026-11-18"], "office", TODAY);
    expect(plan.refreshPlans).toHaveBeenCalledWith(["2026-11-18"]);
    store.setChatPresence.mockImplementation(async () => false);
    plan.refreshPlans.mockClear();
    expect(await recordChatPresence("ala", [TODAY], "office", TODAY)).toEqual([]);
    expect(plan.refreshPlans).not.toHaveBeenCalled();
  });

  it("frees desks for an absence without writing a presence statement", async () => {
    await releaseAwayDays("ala", ["2026-11-16", TODAY], TODAY);
    expect(store.setChatPresence).not.toHaveBeenCalled();
    expect(desks.cancelReservationsForDate).toHaveBeenCalledWith("ala", TODAY);
    expect(plan.refreshPlans).toHaveBeenCalledWith([TODAY]);
  });
});
