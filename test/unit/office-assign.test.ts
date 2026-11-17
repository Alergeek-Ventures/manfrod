import { describe, expect, it } from "vitest";
import {
  assignDesks,
  guestBase,
  guestNames,
  personKey,
  seatingSignature,
  type AssignDesk,
  type AssignPerson,
} from "../../lib/office/assign.ts";

const desk = (id: string, x: number | null, y: number | null, ownerUserId: string | null = null, active = true): AssignDesk => ({
  id,
  label: id.toUpperCase(),
  active,
  x,
  y,
  width: 4,
  height: 2,
  rotation: 0,
  ownerUserId,
});

const user = (id: string, groups: string[] = []): AssignPerson => ({ key: `user:${id}`, userId: id, guestName: null, name: id, groups });
const guest = (name: string, groups: string[] = []): AssignPerson => ({
  key: personKey({ userId: null, guestName: name }),
  userId: null,
  guestName: name,
  name,
  groups,
});

const seats = (result: ReturnType<typeof assignDesks>) =>
  Object.fromEntries(result.assignments.map((assignment) => [assignment.deskId, `${assignment.name}:${assignment.reason}`]));

const DESKS = [desk("a1", 0, 0), desk("a2", 5, 0), desk("a3", 10, 0), desk("b1", 0, 20), desk("b2", 5, 20), desk("b3", 30, 20)];

describe("assignDesks", () => {
  it("keeps manual reservations and seats present owners at their desks", () => {
    const desks = [...DESKS, desk("o1", 40, 0, "olga")];
    const result = assignDesks({
      desks,
      people: [user("olga"), user("ala")],
      awayUserIds: new Set(),
      manual: [{ deskId: "b3", userId: "ala", guestName: null, name: "ala" }],
    });
    expect(seats(result)).toEqual({ b3: "ala:manual", o1: "olga:owner" });
    expect(result.overflow).toEqual([]);
  });

  it("frees the desk of an owner who is away and keeps it blocked when the owner is unknown", () => {
    const desks = [desk("o1", 0, 0, "olga"), desk("o2", 5, 0, "piotr")];
    const result = assignDesks({ desks, people: [user("ala"), user("bob")], awayUserIds: new Set(["olga"]), manual: [] });
    expect(seats(result)).toEqual({ o1: "ala:cluster" });
    expect(result.overflow.map((person) => person.name)).toEqual(["bob"]);
  });

  it("does not hand out an away owner's desk when the owner comes after all", () => {
    const result = assignDesks({
      desks: [desk("o1", 0, 0, "olga"), desk("a1", 5, 0)],
      people: [user("olga"), user("ala")],
      awayUserIds: new Set(["olga"]),
      manual: [],
    });
    expect(seats(result)).toEqual({ o1: "olga:owner", a1: "ala:cluster" });
  });

  it("gives a returning owner their desk back and reseats whoever reserved it", () => {
    const result = assignDesks({
      desks: [desk("o1", 0, 0, "olga"), desk("a1", 5, 0)],
      people: [user("olga")],
      awayUserIds: new Set(),
      manual: [{ deskId: "o1", userId: "ala", guestName: null, name: "ala" }],
    });
    expect(seats(result)).toEqual({ o1: "olga:owner", a1: "ala:cluster" });
    expect(result.displaced.map((person) => person.key)).toEqual(["user:ala"]);
  });

  it("prefers the previous plan, then the most recent desk", () => {
    const result = assignDesks({
      desks: DESKS,
      people: [user("ala"), user("bob"), user("cyd")],
      awayUserIds: new Set(),
      manual: [],
      previous: new Map([["user:bob", "b2"]]),
      recentDesk: new Map([
        ["user:ala", "a3"],
        ["user:bob", "a3"],
        ["user:cyd", "b2"],
      ]),
    });
    expect(seats(result)).toMatchObject({ b2: "bob:previous", a3: "ala:recent" });
    expect(result.assignments.find((assignment) => assignment.name === "cyd")?.reason).toBe("cluster");
  });

  it("seats teammates next to each other", () => {
    const result = assignDesks({
      desks: DESKS,
      people: [user("ala", ["p:x"]), user("bob", ["p:y"]), user("cyd", ["p:x"]), user("dan", ["p:y"])],
      awayUserIds: new Set(),
      manual: [],
      recentDesk: new Map([
        ["user:ala", "a1"],
        ["user:bob", "b1"],
      ]),
    });
    expect(seats(result)).toMatchObject({ a1: "ala:recent", b1: "bob:recent", a2: "cyd:cluster", b2: "dan:cluster" });
  });

  it("is deterministic and reports overflow instead of dropping people", () => {
    const input = {
      desks: [desk("a1", 0, 0), desk("a2", 5, 0), desk("x", null, null), desk("off", 9, 9, null, false)],
      people: [guest("Gość z Wrocławia 2", ["visit:1"]), guest("Gość z Wrocławia 1", ["visit:1"]), user("ala"), user("bob"), user("ala")],
      awayUserIds: new Set<string>(),
      manual: [],
    };
    const first = assignDesks(input);
    const second = assignDesks({ ...input, people: [...input.people].reverse() });
    expect(seatingSignature(first)).toBe(seatingSignature(second));
    expect(first.assignments).toHaveLength(3);
    expect(first.assignments.map((assignment) => assignment.deskId).sort()).toEqual(["a1", "a2", "x"]);
    expect(first.overflow).toHaveLength(1);
    expect(first.freeDeskIds).toEqual([]);
  });

  it("puts desks off the map last", () => {
    const result = assignDesks({
      desks: [desk("z", null, null), desk("a", 3, 3)],
      people: [user("ala")],
      awayUserIds: new Set(),
      manual: [],
    });
    expect(seats(result)).toEqual({ a: "ala:cluster" });
    expect(result.freeDeskIds).toEqual(["z"]);
  });
});

describe("guest names", () => {
  it("names guests after the place in the visit note", () => {
    expect(guestBase("zespół z Wrocławia")).toBe("Gość z Wrocławia");
    expect(guestBase("warsztaty z klientem Acme")).toBe("Gość (warsztaty z klientem)");
    expect(
      guestNames([
        { note: "zespół z Wrocławia", guests: 2 },
        { note: "ludzie z Wrocławia", guests: 1 },
        { note: "nikt", guests: 0 },
      ]),
    ).toEqual(["Gość z Wrocławia 1", "Gość z Wrocławia 2", "Gość z Wrocławia 3"]);
  });
});
