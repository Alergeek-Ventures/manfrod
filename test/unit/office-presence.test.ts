import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OfficeVisit } from "../../lib/db/schema.ts";
import { parseLeaveRequests, parseSessionDays } from "../../lib/office/presence-firmowid.ts";
import { HABIT_MAX_CONFIDENCE, resolvePresence, type SessionDay } from "../../lib/office/presence-resolve.ts";

const sources = vi.hoisted(() => ({
  loadMembers: vi.fn(),
  loadPeople: vi.fn(),
  loadExplicit: vi.fn(),
  loadAbsences: vi.fn(),
  loadReservationDates: vi.fn(),
  loadStatedOffice: vi.fn(async () => [] as unknown[]),
  loadManualSeats: vi.fn(async () => [] as unknown[]),
}));
const store = vi.hoisted(() => ({
  defaultLayoutId: vi.fn(async () => "layout-1"),
  listVisits: vi.fn(),
  setPresence: vi.fn(),
  clearPresence: vi.fn(),
  recordVisit: vi.fn(),
  cancelVisit: vi.fn(),
  getVisit: vi.fn(),
  updateVisit: vi.fn(),
}));
const firmowid = vi.hoisted(() => ({
  firmowidAccess: vi.fn(),
  callTool: vi.fn(),
}));

vi.mock("../../lib/office/presence-sources.ts", () => sources);
vi.mock("../../lib/office/presence-store.ts", () => store);
vi.mock("../../lib/nudges/signals.ts", () => ({ firmowidAccess: firmowid.firmowidAccess }));
vi.mock("../../lib/mcp/client.ts", () => ({ callTool: firmowid.callTool }));

const { predictOfficeDay } = await import("../../lib/office/presence.ts");

const TODAY = "2026-11-17";
const THURSDAY = "2026-11-19";
const PAST_THURSDAYS = ["2026-10-22", "2026-10-29", "2026-11-05", "2026-11-12"];

const days = (remote: boolean[], dates = PAST_THURSDAYS): SessionDay[] => dates.map((date, index) => ({ date, remote: remote[index] }));

describe("resolvePresence", () => {
  const base = { date: THURSDAY, today: TODAY };
  const leave = { startsOn: "2026-11-18", endsOn: "2026-11-20", status: "approved", category: "vacation", reason: "rest" };

  it("puts an explicit statement above everything else", () => {
    const resolved = resolvePresence({
      ...base,
      explicit: { status: "remote", source: "chat", note: "u klienta" },
      leaveRequests: [leave],
      visit: { note: "Wrocław" },
    });
    expect(resolved).toEqual({
      status: "remote",
      confidence: 1,
      sources: ["explicit_chat"],
      reason: "zapowiedział(a) pracę zdalną: u klienta",
    });
  });

  it("follows the documented priority", () => {
    const habit = days([false, false, false, false]);
    expect(resolvePresence({ ...base, leaveRequests: [leave], absences: ["x"], visit: { note: "v" } })).toMatchObject({
      status: "leave",
      sources: ["firmowid_leave"],
      reason: "urlop w Firmowidzie",
    });
    expect(resolvePresence({ ...base, absences: ["2026-11-19..2026-11-19 — urlop"], visit: { note: "v" } })).toMatchObject({
      status: "leave",
      sources: ["absence"],
    });
    expect(resolvePresence({ ...base, absences: ["2026-11-19..2026-11-19 — pracuje poza biurem: konferencja"] })).toMatchObject({
      status: "remote",
      sources: ["absence"],
    });
    expect(resolvePresence({ ...base, visit: { note: "zespół z Wrocławia" }, sessionDays: days([true, true, true, true]) })).toMatchObject({
      status: "office",
      sources: ["visit"],
      reason: "wizyta: zespół z Wrocławia",
    });
    expect(resolvePresence({ ...base, reservedThatDay: true, sessionDays: days([true, true, true, true]) })).toMatchObject({
      status: "office",
      sources: ["reservation"],
    });
    expect(resolvePresence({ ...base, sessionDays: habit, reservationDates: [] })).toMatchObject({ sources: ["firmowid_habit"] });
    expect(resolvePresence(base)).toEqual({ status: "unknown", confidence: 0, sources: ["none"], reason: "brak danych" });
  });

  it("ignores rejected and cancelled leave requests and reads remote-work requests as remote", () => {
    expect(
      resolvePresence({
        ...base,
        leaveRequests: [
          { ...leave, status: "rejected" },
          { ...leave, status: "cancelled" },
        ],
      }).status,
    ).toBe("unknown");
    expect(resolvePresence({ ...base, leaveRequests: [{ ...leave, status: "pending" }] })).toMatchObject({
      status: "leave",
      confidence: 0.8,
      reason: "wniosek urlopowy w Firmowidzie",
    });
    expect(resolvePresence({ ...base, leaveRequests: [{ ...leave, category: "remote_work" }] }).status).toBe("remote");
    expect(resolvePresence({ ...base, leaveRequests: [{ ...leave, startsOn: "2026-11-20" }] }).status).toBe("unknown");
  });

  it("uses a session on the day only for today and the past", () => {
    const today = { date: TODAY, today: TODAY };
    expect(resolvePresence({ ...today, sessionDays: [{ date: TODAY, remote: true }] })).toMatchObject({
      status: "remote",
      sources: ["firmowid_session"],
    });
    expect(resolvePresence({ ...base, sessionDays: [{ date: THURSDAY, remote: false }] }).status).toBe("unknown");
  });

  it("needs a minimum sample and a clear share for a weekday habit", () => {
    expect(resolvePresence({ ...base, sessionDays: days([false, false], PAST_THURSDAYS.slice(2)) }).status).toBe("unknown");
    expect(resolvePresence({ ...base, sessionDays: days([false, true, false, true]) }).status).toBe("unknown");
    expect(resolvePresence({ ...base, sessionDays: days([false, false, false, true]) })).toEqual({
      status: "office",
      confidence: Math.round(0.75 * HABIT_MAX_CONFIDENCE * 100) / 100,
      sources: ["firmowid_habit"],
      reason: "zwykle w biurze w czwartki (3/4)",
    });
    expect(resolvePresence({ ...base, sessionDays: days([true, true, true, false]) })).toMatchObject({
      status: "remote",
      reason: "zwykle zdalnie w czwartki (3/4)",
    });
    const wednesdays = days([false, false, false, false], ["2026-10-21", "2026-10-28", "2026-11-04", "2026-11-11"]);
    expect(resolvePresence({ ...base, sessionDays: wednesdays }).status).toBe("unknown");
    const tooOld = days([false, false, false], ["2026-09-03", "2026-09-10", "2026-09-17"]);
    expect(resolvePresence({ ...base, sessionDays: tooOld }).status).toBe("unknown");
  });

  it("falls back to a desk reservation habit when Firmowid says nothing clear", () => {
    expect(resolvePresence({ ...base, reservationDates: PAST_THURSDAYS.slice(0, 2) }).status).toBe("unknown");
    expect(
      resolvePresence({ ...base, sessionDays: days([false, true, false, true]), reservationDates: PAST_THURSDAYS.slice(0, 3) }),
    ).toEqual({
      status: "office",
      confidence: 0.26,
      sources: ["reservation_habit"],
      reason: "zwykle rezerwuje biurko w czwartki (3/8)",
    });
  });
});

describe("Firmowid parsing", () => {
  it("turns sessions into one office or remote flag per Warsaw day", () => {
    expect(
      parseSessionDays([
        { start_datetime: "2026-11-12T08:00:00Z", is_remote: true },
        { start_datetime: "2026-11-12T13:00:00Z", is_remote: false },
        { start_datetime: "2026-11-13T23:30:00Z", is_remote: true },
        { start_datetime: "2026-11-10T08:00:00Z", is_remote: null },
        { start_datetime: "nonsense", is_remote: true },
      ]),
    ).toEqual([
      { date: "2026-11-12", remote: false },
      { date: "2026-11-14", remote: true },
    ]);
  });

  it("reads leave requests and skips malformed ones", () => {
    expect(
      parseLeaveRequests([
        { starts_on: "2026-11-18", ends_on: "2026-11-20", status: "approved", category: "vacation", reason: "rest" },
        { starts_on: "2026-11-25T00:00:00Z", status: "pending" },
        { starts_on: "soon" },
      ]),
    ).toEqual([
      { startsOn: "2026-11-18", endsOn: "2026-11-20", status: "approved", category: "vacation", reason: "rest" },
      { startsOn: "2026-11-25", endsOn: "2026-11-25", status: "pending", category: null, reason: null },
    ]);
  });
});

describe("predictOfficeDay", () => {
  const person = (userId: string, name: string) => ({ userId, name, slackId: `U${userId}` });
  const visit = {
    id: "visit-1",
    layoutId: "layout-1",
    startsOn: THURSDAY,
    endsOn: THURSDAY,
    userIds: ["visitor", "dana"],
    guests: 3,
    guestNames: [],
    note: "zespół z Wrocławia",
    createdBy: "ala",
    cancelledAt: null,
    insertedAt: new Date(),
  } satisfies OfficeVisit;
  const sessions = (remote: boolean[]) => ({
    ok: true,
    value: {
      structuredContent: {
        results: PAST_THURSDAYS.map((date, index) => ({ start_datetime: `${date}T09:00:00Z`, is_remote: remote[index] })),
      },
    },
  });

  beforeEach(() => {
    vi.clearAllMocks();
    sources.loadMembers.mockResolvedValue([
      person("ala", "Ala"),
      person("bartek", "Bartek"),
      person("cezary", "Cezary"),
      person("dana", "Dana"),
      person("ewa", "Ewa"),
    ]);
    sources.loadPeople.mockImplementation(async (ids: string[]) => ids.map((id) => person(id, "Gość z Wrocławia")));
    sources.loadExplicit.mockResolvedValue([
      { id: "p1", userId: "cezary", date: THURSDAY, status: "office", source: "button", note: null, updatedAt: new Date() },
    ]);
    sources.loadAbsences.mockResolvedValue(new Map([["ewa", ["2026-11-19..2026-11-21 — urlop"]]]));
    sources.loadReservationDates.mockResolvedValue(new Map());
    store.listVisits.mockResolvedValue([visit]);
    firmowid.firmowidAccess.mockImplementation(async (userId: string) =>
      userId === "cezary" ? null : { mcpUrl: "https://firmowid.test/mcp", token: userId },
    );
    firmowid.callTool.mockImplementation(async (_url: string, token: string, name: string) => {
      if (name === "list_leave_requests") return { ok: true, value: { structuredContent: { results: [] } } };
      if (token === "ala") return sessions([false, false, false, false]);
      if (token === "bartek") return sessions([true, true, true, false]);
      if (token === "ewa") throw new Error("boom");
      return { ok: false, error: "unauthorized" };
    });
  });

  it("combines every source, adds visitors and counts guests", async () => {
    const prediction = await predictOfficeDay(THURSDAY, { today: TODAY });
    const byId = Object.fromEntries(prediction.people.map((entry) => [entry.userId, entry]));

    expect(byId.ala).toMatchObject({ status: "office", sources: ["firmowid_habit"], name: "Ala", slackId: "Uala" });
    expect(byId.bartek).toMatchObject({ status: "remote", reason: "zwykle zdalnie w czwartki (3/4)" });
    expect(byId.cezary).toMatchObject({ status: "office", sources: ["explicit_button"] });
    expect(byId.dana).toMatchObject({ status: "office", sources: ["visit"] });
    expect(byId.ewa).toMatchObject({ status: "leave", sources: ["absence"] });
    expect(byId.visitor).toMatchObject({ status: "office", sources: ["visit"], name: "Gość z Wrocławia" });
    expect(prediction.people.map((entry) => entry.status)).toEqual(["office", "office", "office", "office", "remote", "leave"]);
    expect(prediction.guests).toBe(3);
    expect(prediction.guestList.map((guest) => guest.name)).toEqual(["Gość z Wrocławia 1", "Gość z Wrocławia 2", "Gość z Wrocławia 3"]);
    expect(prediction.expectedInOffice).toBe(7);
    expect(prediction.visits).toEqual([visit]);

    expect(sources.loadPeople).toHaveBeenCalledWith(["visitor"]);
    expect(sources.loadExplicit).toHaveBeenCalledTimes(1);
    expect(sources.loadReservationDates).toHaveBeenCalledWith("layout-1", expect.any(Array), "2026-09-22", THURSDAY);
    expect(firmowid.callTool).toHaveBeenCalledWith("https://firmowid.test/mcp", "ala", "list_sessions", {
      input: { after_date: "2026-09-22" },
      limit: expect.any(Number),
      sort: [{ field: "start_datetime", direction: "desc" }],
    });
  });

  it("returns an empty day when there is no office", async () => {
    store.defaultLayoutId.mockResolvedValueOnce(null as never);
    expect(await predictOfficeDay(THURSDAY, { today: TODAY })).toEqual({
      date: THURSDAY,
      layoutId: null,
      people: [],
      visits: [],
      roster: [],
      guestList: [],
      guests: 0,
      expectedInOffice: 0,
    });
  });

  it("adds non-members who said they will come and does not count them as guests too", async () => {
    sources.loadStatedOffice.mockResolvedValueOnce([person("mariusz", "Mariusz Ciastoń"), person("cezary", "Cezary")]);
    sources.loadExplicit.mockResolvedValueOnce([
      { id: "p1", userId: "cezary", date: THURSDAY, status: "office", source: "button", note: null, updatedAt: new Date() },
      { id: "p2", userId: "mariusz", date: THURSDAY, status: "office", source: "chat", note: null, updatedAt: new Date() },
    ]);
    store.listVisits.mockResolvedValueOnce([
      { ...visit, userIds: ["staszek"], createdBy: "staszek", guests: 2, guestNames: ["Odul", "Mariusz"], note: "okres próbny" },
    ]);
    sources.loadPeople.mockImplementationOnce(async (ids: string[]) => ids.map((id) => person(id, "Staszek")));
    const prediction = await predictOfficeDay(THURSDAY, { today: TODAY });
    expect(prediction.people.filter((entry) => entry.userId === "cezary")).toHaveLength(1);
    expect(prediction.people.find((entry) => entry.userId === "mariusz")).toMatchObject({ status: "office", sources: ["explicit_chat"] });
    expect(prediction.guestList.map((guest) => guest.name)).toEqual(["Odul (gość)"]);
    expect(prediction.guests).toBe(1);
    expect(prediction.expectedInOffice).toBe(prediction.roster.length);
  });
});
