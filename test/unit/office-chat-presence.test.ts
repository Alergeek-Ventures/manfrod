import { beforeEach, describe, expect, it, vi } from "vitest";

const desks = vi.hoisted(() => ({ cancelReservationsForDate: vi.fn(async () => [] as string[]) }));
const plan = vi.hoisted(() => ({ refreshPlans: vi.fn(async (dates: string[]) => dates) }));
const store = vi.hoisted(() => ({ setPresence: vi.fn(async () => ({})) }));

vi.mock("../../lib/desks.ts", () => desks);
vi.mock("../../lib/office/plan.ts", () => plan);
vi.mock("../../lib/office/presence-store.ts", () => store);

const { recordChatPresence, releaseAwayDays } = await import("../../lib/office/chat-presence.ts");

const TODAY = "2026-11-17";

beforeEach(() => vi.clearAllMocks());

describe("presence said in chat", () => {
  it("records remote days from today, frees the desks and refreshes the plans", async () => {
    await recordChatPresence("ala", ["2026-11-16", TODAY, "2026-11-18"], "remote", TODAY);
    expect(store.setPresence.mock.calls).toEqual([
      ["ala", TODAY, "remote", "chat"],
      ["ala", "2026-11-18", "remote", "chat"],
    ]);
    expect(desks.cancelReservationsForDate.mock.calls).toEqual([
      ["ala", TODAY],
      ["ala", "2026-11-18"],
    ]);
    expect(plan.refreshPlans).toHaveBeenCalledWith([TODAY, "2026-11-18"]);
  });

  it("keeps desk bookings for office days", async () => {
    await recordChatPresence("ala", ["2026-11-18"], "office", TODAY);
    expect(desks.cancelReservationsForDate).not.toHaveBeenCalled();
    expect(plan.refreshPlans).toHaveBeenCalledWith(["2026-11-18"]);
  });

  it("frees desks for an absence without writing a presence statement", async () => {
    await releaseAwayDays("ala", ["2026-11-16", TODAY], TODAY);
    expect(store.setPresence).not.toHaveBeenCalled();
    expect(desks.cancelReservationsForDate).toHaveBeenCalledWith("ala", TODAY);
    expect(plan.refreshPlans).toHaveBeenCalledWith([TODAY]);
  });
});
