import { describe, expect, it } from "vitest";
import { buildMapState, placedDesks, type MapDeskInput, type MapReservation } from "../../lib/office/state.ts";

const layout = { id: "layout", name: "Biuro", width: 40, height: 30, elements: [] };

const desk = (label: string, extra: Partial<MapDeskInput> = {}): MapDeskInput => ({
  id: label,
  label,
  equipment: [],
  active: true,
  x: 1,
  y: 1,
  width: 6,
  height: 4,
  rotation: 0,
  ownerUserId: null,
  ownerName: null,
  ...extra,
});

const booking = (deskId: string, extra: Partial<MapReservation> = {}): MapReservation => ({
  deskId,
  userId: "booker",
  guestName: null,
  name: "Staszek Wiśniewski",
  source: "manual",
  ...extra,
});

describe("buildMapState", () => {
  it("gives every desk one of the four statuses", () => {
    const state = buildMapState({
      date: "2026-11-17",
      layout,
      desks: [
        desk("Free"),
        desk("Booked"),
        desk("OwnerIn", { ownerUserId: "anna", ownerName: "Anna Nowak" }),
        desk("OwnerOut", { ownerUserId: "piotr", ownerName: "Piotr Zieliński" }),
      ],
      reservations: [booking("Booked")],
      awayUserIds: new Set(["piotr"]),
    });
    const byLabel = Object.fromEntries(state.desks.map((item) => [item.label, item]));
    expect(byLabel.Free).toMatchObject({ status: "free", name: null });
    expect(byLabel.Booked).toMatchObject({ status: "taken", name: "Staszek", fullName: "Staszek Wiśniewski" });
    expect(byLabel.OwnerIn).toMatchObject({ status: "owner_present", name: "Anna" });
    expect(byLabel.OwnerOut).toMatchObject({ status: "owner_away", name: "Piotr" });
  });

  it("shows who booked an owner's desk while the owner is away", () => {
    const state = buildMapState({
      date: "2026-11-17",
      layout,
      desks: [desk("T1", { ownerUserId: "piotr", ownerName: "Piotr" })],
      reservations: [booking("T1")],
      awayUserIds: new Set(["piotr"]),
    });
    expect(state.desks[0]).toMatchObject({ status: "taken", name: "Staszek", ownerName: "Piotr" });
  });

  it("keeps guest names whole and tells apart people with the same first name", () => {
    const state = buildMapState({
      date: "2026-11-17",
      layout,
      desks: [desk("A"), desk("B"), desk("C")],
      reservations: [
        booking("A", { userId: "k1", name: "Kamil Marczak" }),
        booking("B", { userId: "k2", name: "Kamil Nowak" }),
        booking("C", { userId: null, name: null, guestName: "Gość z Wrocławia" }),
      ],
      awayUserIds: new Set(),
    });
    expect(state.desks.map((item) => item.name)).toEqual(["Kamil M.", "Kamil N.", "Gość z Wrocławia"]);
  });

  it("drops inactive desks and keeps unplaced ones off the map", () => {
    const state = buildMapState({
      date: "2026-11-17",
      layout,
      desks: [desk("T10"), desk("T2"), desk("Old", { active: false }), desk("Agata", { x: null, y: null })],
      reservations: [],
      awayUserIds: new Set(),
    });
    expect(state.desks.map((item) => item.label)).toEqual(["Agata", "T2", "T10"]);
    expect(placedDesks(state).map((item) => item.label)).toEqual(["T2", "T10"]);
  });

  it("ignores malformed layout elements", () => {
    const state = buildMapState({
      date: "2026-11-17",
      layout: {
        ...layout,
        elements: [
          { id: "r", kind: "room", x: 0, y: 0, width: 5, height: 5, rotation: 0 },
          { id: "bad", kind: "sofa" },
        ],
      },
      desks: [],
      reservations: [],
      awayUserIds: new Set(),
    });
    expect(state.layout.elements.map((element) => element.id)).toEqual(["r"]);
  });
});
