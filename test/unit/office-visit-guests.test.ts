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

  it("reproduces #biuro 20.11: Mariusz with a Slack account takes his unnamed slot of 'Odul i Mariusz'", () => {
    const odulAndMariusz = visit({
      note: "Odul i Mariusz będą w biurze od 2026-11-19 przez dwa tygodnie próbne, pracując przy Firmowidzie.",
    });
    expect(names(visitGuests([odulAndMariusz], [user("mariusz", "Mariusz Ciastoń")]))).toEqual(["Gość 1"]);
    expect(names(visitGuests([odulAndMariusz], []))).toEqual(["Gość 1", "Gość 2"]);
  });

  it("never lets an office member named in the note take an unnamed slot", () => {
    const guests = visitGuests([visit({ guests: 1, note: "spotkanie z Kasią" })], [user("kasia", "Kasia Zając")], new Set(["kasia"]));
    expect(guests).toHaveLength(1);
  });

  it("matches the note only by a whole first name that a single present person has", () => {
    const twoMariusz = [user("a", "Mariusz Ciastoń"), user("b", "Mariusz Nowak")];
    expect(visitGuests([visit({ note: "Mariusz i ktoś" })], twoMariusz)).toHaveLength(2);
    expect(visitGuests([visit({ note: "Mariuszowie z Wrocławia" })], [user("a", "Mariusz Ciastoń")])).toHaveLength(2);
  });

  it("takes at most the unnamed slots and leaves named guests alone", () => {
    const present = [user("mariusz", "Mariusz Ciastoń"), user("kasia", "Kasia Zając")];
    expect(visitGuests([visit({ guests: 1, note: "Mariusz i Kasia" })], present)).toEqual([]);
    const guests = visitGuests([visit({ guests: 2, guestNames: ["Odul"], note: "Odul i Mariusz" })], present);
    expect(names(guests)).toEqual(["Odul (gość)"]);
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
      away: new Set(),
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

describe("dayRoster with an unnamed visit", () => {
  it("counts Mariusz once when he says he is coming and books a desk on a visit that names him only in the note", () => {
    const roster = dayRoster({
      people: [
        { userId: "ala", name: "Ala", slackId: "UALA", status: "office" },
        { userId: "mariusz", name: "Mariusz Ciastoń", slackId: "UM", status: "office" },
      ],
      visits: [visit({ note: "Odul i Mariusz na okres próbny" })],
      manual: [{ userId: "mariusz", guestName: null, name: "Mariusz Ciastoń", slackId: "UM" }],
      memberIds: new Set(["ala"]),
      away: new Set(),
    });
    expect(roster.people.map((person) => person.key)).toEqual(["user:ala", "user:mariusz", "guest:v1:gość 1"]);
  });
});

describe("dayRoster and confirmed absence", () => {
  const base = {
    people: [{ userId: "ala", name: "Ala", slackId: "UALA", status: "remote" }],
    visits: [],
    manual: [{ userId: "ala", guestName: null, name: "Ala", slackId: "UALA" }],
    memberIds: new Set(["ala"]),
  };

  it("does not count someone confirmed away even with a desk booking", () => {
    expect(dayRoster({ ...base, away: new Set(["ala"]) }).people).toEqual([]);
  });

  it("keeps a booking when the absence is only predicted", () => {
    expect(dayRoster({ ...base, away: new Set() }).people.map((person) => person.key)).toEqual(["user:ala"]);
  });
});
