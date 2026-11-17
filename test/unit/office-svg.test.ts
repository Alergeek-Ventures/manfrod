import { describe, expect, it } from "vitest";
import { buildMapState, type MapDeskInput } from "../../lib/office/state.ts";
import { deskBox, freeDesks, polishDate, renderSvg, seatSide, UNIT } from "../../lib/office/svg.ts";

const desk = (label: string, extra: Partial<MapDeskInput> = {}): MapDeskInput => ({
  id: label,
  label,
  equipment: ["usb-c"],
  active: true,
  x: 2,
  y: 2,
  width: 6,
  height: 4,
  rotation: 0,
  ownerUserId: null,
  ownerName: null,
  ...extra,
});

const state = buildMapState({
  date: "2026-11-17",
  layout: {
    id: "l",
    name: "Biuro",
    width: 40,
    height: 30,
    elements: [
      { id: "r", kind: "room", x: 0, y: 0, width: 20, height: 15, rotation: 0, label: "Open <space>" },
      { id: "w", kind: "wall", x: 0, y: 0, width: 40, height: 1, rotation: 0 },
      { id: "d", kind: "door", x: 10, y: 0, width: 3, height: 3, rotation: 180 },
    ],
  },
  desks: [
    desk("T1"),
    desk("T2", { x: 10, ownerUserId: "anna", ownerName: "Anna Nowak" }),
    desk("T3", { x: 20, ownerUserId: "piotr", ownerName: "Piotr Zieliński" }),
    desk("B1", { x: 30, rotation: 90 }),
    desk("Hidden", { x: null, y: null }),
  ],
  reservations: [{ deskId: "B1", userId: null, guestName: "Staszek & Co", name: null, source: "plan" }],
  awayUserIds: new Set(["piotr"]),
});

describe("renderSvg", () => {
  const svg = renderSvg(state);

  it("draws each placed desk with its status", () => {
    expect(svg).toContain('data-desk="T1" data-status="free"');
    expect(svg).toContain('data-desk="T2" data-status="owner_present"');
    expect(svg).toContain('data-desk="T3" data-status="owner_away"');
    expect(svg).toContain('data-desk="B1" data-status="taken"');
    expect(svg).not.toContain('data-desk="Hidden"');
  });

  it("writes names, escapes them and adds a Polish header and legend", () => {
    expect(svg).toContain(">Anna<");
    expect(svg).toContain("Piotr poza biurem");
    expect(svg).toContain(">Staszek<");
    expect(svg).toContain(">&amp; Co<");
    expect(svg).toContain("OPEN &lt;SPACE&gt;");
    expect(svg).toContain("wtorek, 17 listopada 2026");
    expect(svg).toContain("Właściciel nieobecny");
    expect(svg).toContain("2 wolne biurka");
  });

  it("uses a custom title and date", () => {
    const custom = renderSvg(state, { title: "Plan na jutro", date: "2026-11-18" });
    expect(custom).toContain("Plan na jutro");
    expect(custom).toContain("środa, 18 listopada 2026");
  });

  it("turns sideways desks and moves the seat with the rotation", () => {
    const sideways = state.desks.find((item) => item.label === "B1")!;
    const box = deskBox({ ...sideways, x: 30, y: 2 });
    expect(box).toEqual({ x: 30 * UNIT, y: 2 * UNIT, width: 4 * UNIT, height: 6 * UNIT });
    expect([0, 90, 180, 270].map(seatSide)).toEqual(["bottom", "left", "top", "right"]);
  });

  it("produces well-formed markup", () => {
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg.trim().endsWith("</svg>")).toBe(true);
    expect(svg.match(/<g\b/g)?.length).toBe(svg.match(/<\/g>/g)?.length);
  });
});

describe("Polish formatting", () => {
  it("names weekdays and pluralises free desks", () => {
    expect(polishDate("2026-11-22")).toBe("niedziela, 22 listopada 2026");
    expect([0, 1, 2, 4, 5, 12, 22, 25].map(freeDesks)).toEqual([
      "0 wolnych biurek",
      "1 wolne biurko",
      "2 wolne biurka",
      "4 wolne biurka",
      "5 wolnych biurek",
      "12 wolnych biurek",
      "22 wolne biurka",
      "25 wolnych biurek",
    ]);
  });
});
