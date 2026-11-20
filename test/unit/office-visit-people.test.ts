import { beforeEach, describe, expect, it, vi } from "vitest";

const people = vi.hoisted(() => ({ resolvePerson: vi.fn() }));
vi.mock("../../lib/people.ts", () => people);

const { resolveVisitPeople } = await import("../../lib/office/visit-people.ts");

beforeEach(() => {
  vi.clearAllMocks();
  people.resolvePerson.mockImplementation(async (name: string) => {
    if (name === "Mariusz") return { ok: true, user: { id: "mariusz" } };
    if (name === "Anna") return { ok: false, unknown: false, message: "pasuje do kilku osób" };
    return { ok: false, unknown: true, message: "nie znam" };
  });
});

describe("resolveVisitPeople", () => {
  it("resolves only exact matches and keeps ambiguous or unknown names as named guests", async () => {
    expect(await resolveVisitPeople(["Mariusz", "Anna", "Odul", "<@UNKNOWN1>", " "])).toEqual({
      userIds: ["mariusz"],
      guestNames: ["Anna", "Odul"],
    });
    for (const [name, options] of people.resolvePerson.mock.calls) expect(options, name).toEqual({ strict: true });
  });
});
