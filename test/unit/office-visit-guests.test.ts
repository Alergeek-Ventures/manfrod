import { describe, expect, it } from "vitest";
import { assignDesks } from "../../lib/office/assign.ts";
import { dayRoster } from "../../lib/office/roster.ts";
import { visitGuests, visitPlace } from "../../lib/office/visit-guests.ts";

const visit = (extra: Record<string, unknown> = {}) => ({
  id: "v1",
  guests: 2,
  guestNames: [] as string[],
  note: "zespół z Wrocławia",
  userIds: [] as string[],
  ...extra,
});

const user = (userId: string, name: string) => ({ key: `user:${userId}`, userId, name });
const names = (guests: { name: string }[]) => guests.map((guest) => guest.name);

describe("visitGuests", () => {
  it("names anonymous guests after the place in the note and numbers them across visits", () => {
    expect(names(visitGuests([visit(), visit({ id: "v2", guests: 1, note: "ludzie z Wrocławia" })], []))).toEqual([
      "Gość z Wrocławia 1",
      "Gość z Wrocławia 2",
      "Gość z Wrocławia 3",
    ]);
    expect(visitGuests([visit({ guests: 1, note: "warsztaty z klientem acme" })], [])[0].name).toBe("Gość 1");
    expect(visitPlace("warsztaty z klientem")).toBeNull();
  });

  it("names a guest by their own name, never by the note", () => {
    const guests = visitGuests([visit({ guests: 3, guestNames: ["Odul"], note: "Odul i Mariusz na okres próbny" })], []);
    expect(guests.map((guest) => [guest.name, guest.named])).toEqual([
      ["Odul (gość)", true],
      ["Gość 1", false],
      ["Gość 2", false],
    ]);
  });

  it("reproduces #biuro: Mariusz says he will come while the visit names him as a guest", () => {
    const guests = visitGuests(
      [visit({ guestNames: ["Odul", "Mariusz"], userIds: ["staszek"] })],
      [user("staszek", "Staszek Nowak"), user("mariusz", "Mariusz Ciastoń")],
    );
    expect(names(guests)).toEqual(["Odul (gość)"]);
  });

  it("drops a guest by full name, even for an office member", () => {
    const guests = visitGuests([visit({ guests: 1, guestNames: ["Mariusz Kowalski"] })], [user("m", "Mariusz Kowalski")], new Set(["m"]));
    expect(guests).toEqual([]);
  });

  it("never drops a first-name guest because an office member shares the first name", () => {
    const guests = visitGuests([visit({ guests: 1, guestNames: ["Mariusz"] })], [user("m", "Mariusz Kowalski")], new Set(["m"]));
    expect(names(guests)).toEqual(["Mariusz (gość)"]);
  });

  it("keeps a first-name guest when two seated non-members share that first name", () => {
    const present = [user("a", "Anna Kowalska"), user("b", "Anna Nowak")];
    expect(names(visitGuests([visit({ guests: 1, guestNames: ["Anna"] })], present))).toEqual(["Anna (gość)"]);
  });

  it("never matches an anonymous guest from the note", () => {
    const guests = visitGuests([visit({ guests: 1, note: "spotkanie z Kasią" })], [user("kasia", "Kasia Zając")]);
    expect(guests).toHaveLength(1);
    const named = visitGuests([visit({ guests: 2, note: "Mariusz i ktoś" })], [user("mariusz", "Mariusz Ciastoń")]);
    expect(named).toHaveLength(2);
  });

  it("lets one person cancel out only one guest and never the visit's own people", () => {
    const present = [user("mariusz", "Mariusz Ciastoń")];
    const both = [visit({ guests: 1, guestNames: ["Mariusz"] }), visit({ id: "v2", guests: 1, guestNames: ["Mariusz Ciastoń"] })];
    expect(visitGuests(both, present)).toHaveLength(1);
    expect(visitGuests([visit({ guests: 1, guestNames: ["Mariusz"], userIds: ["mariusz"] })], present)).toHaveLength(1);
  });

  it("matches names regardless of case and Polish letters", () => {
    expect(visitGuests([visit({ guests: 1, guestNames: ["ZANETA"] })], [user("z", "Żaneta")])).toHaveLength(0);
  });
});

describe("dayRoster", () => {
  const desk = (id: string, x: number) => ({ id, label: id, active: true, x, y: 0, width: 1, height: 1, rotation: 0, ownerUserId: null });

  it("gives the same count for the forecast, the headline and the seats", () => {
    const roster = dayRoster({
      people: [
        { userId: "ala", name: "Ala", slackId: "UALA", status: "office" },
        { userId: "mariusz", name: "Mariusz Ciastoń", slackId: "UM", status: "office" },
        { userId: "bob", name: "Bob", slackId: "UBOB", status: "remote" },
      ],
      visits: [visit({ guests: 3, guestNames: ["Odul", "Mariusz"], note: "okres próbny" })],
      manual: [
        { userId: "cyd", guestName: null, name: "Cyd", slackId: "UCYD" },
        { userId: null, guestName: "Zenek", name: "Zenek", slackId: null },
      ],
      memberIds: new Set(["ala", "bob", "cyd"]),
    });
    expect(roster.people.map((person) => person.key)).toEqual([
      "user:ala",
      "user:mariusz",
      "user:cyd",
      "guest:zenek",
      "guest:v1:odul (gość)",
      "guest:v1:gość 1",
    ]);
    const result = assignDesks({
      desks: ["a", "b", "c", "d", "e"].map((id, index) => desk(id, index)),
      people: roster.people,
      awayUserIds: new Set(),
      manual: [{ deskId: "a", userId: "cyd", guestName: null, name: "Cyd" }],
    });
    expect(result.assignments.length + result.overflow.length).toBe(roster.people.length);
  });
});
