import { describe, expect, it } from "vitest";
import {
  clampToGrid,
  elementsSchema,
  fitDeskGeometry,
  fitInside,
  footprint,
  layoutSettingsSchema,
  nextRotation,
  parseElements,
  splitTags,
} from "../../lib/office/model.ts";

const room = { id: "r1", kind: "room", x: 2, y: 3, width: 10, height: 6, rotation: 0, label: "Open space" };

describe("office layout elements", () => {
  it("accepts rooms, walls, doors and labels", () => {
    const parsed = elementsSchema.parse([
      room,
      { id: "w1", kind: "wall", x: 0, y: 0, width: 20, height: 1 },
      { id: "d1", kind: "door", x: 4, y: 0, width: 3, height: 3, rotation: 270 },
      { id: "l1", kind: "label", x: 4, y: 4, width: 6, height: 2, rotation: 90, label: "Okna" },
    ]);
    expect(parsed[1].rotation).toBe(0);
    expect(parsed.map((element) => element.kind)).toEqual(["room", "wall", "door", "label"]);
  });

  it("rejects unknown kinds, odd rotations, fractions and negative positions", () => {
    expect(elementsSchema.safeParse([{ ...room, kind: "sofa" }]).success).toBe(false);
    expect(elementsSchema.safeParse([{ ...room, rotation: 45 }]).success).toBe(false);
    expect(elementsSchema.safeParse([{ ...room, x: 1.5 }]).success).toBe(false);
    expect(elementsSchema.safeParse([{ ...room, y: -1 }]).success).toBe(false);
    expect(elementsSchema.safeParse([{ ...room, width: 0 }]).success).toBe(false);
  });

  it("drops only the invalid elements when reading stored JSON", () => {
    expect(parseElements([room, { id: "x" }, null]).map((element) => element.id)).toEqual(["r1"]);
    expect(parseElements("nope")).toEqual([]);
  });

  it("swaps width and height of the footprint when turned sideways", () => {
    expect(footprint({ x: 1, y: 2, width: 6, height: 4, rotation: 0 })).toEqual({ x: 1, y: 2, width: 6, height: 4 });
    expect(footprint({ x: 1, y: 2, width: 6, height: 4, rotation: 90 })).toEqual({ x: 1, y: 2, width: 4, height: 6 });
    expect(footprint({ x: 1, y: 2, width: 6, height: 4, rotation: 180 })).toEqual({ x: 1, y: 2, width: 6, height: 4 });
    expect(footprint({ x: 1, y: 2, width: 6, height: 4, rotation: 270 })).toEqual({ x: 1, y: 2, width: 4, height: 6 });
    expect([0, 90, 180, 270].map(nextRotation)).toEqual([90, 180, 270, 0]);
  });

  it("keeps boxes inside the grid", () => {
    expect(clampToGrid({ x: 58, y: -3, width: 6, height: 4 }, { width: 60, height: 40 })).toEqual({ x: 54, y: 0 });
  });

  it("pulls items back inside a shrunk grid", () => {
    const grid = { width: 20, height: 12 };
    expect(fitInside({ id: "w", x: 30, y: 30, width: 6, height: 4, rotation: 0 }, grid)).toEqual({
      id: "w",
      x: 14,
      y: 8,
      width: 6,
      height: 4,
      rotation: 0,
    });
    expect(fitInside({ x: 18, y: 0, width: 6, height: 4, rotation: 90 }, grid)).toEqual({ x: 16, y: 0, width: 6, height: 4, rotation: 90 });
    expect(fitInside({ x: 5, y: 5, width: 40, height: 30, rotation: 0 }, grid)).toEqual({ x: 0, y: 0, width: 20, height: 12, rotation: 0 });
  });

  it("leaves unplaced desks unplaced and clamps placed ones", () => {
    const grid = { width: 20, height: 12 };
    const unplaced = { x: null, y: null, width: 6, height: 4, rotation: 0 as const };
    expect(fitDeskGeometry(unplaced, grid)).toBe(unplaced);
    expect(fitDeskGeometry({ ...unplaced, x: 50, y: 50 }, grid)).toEqual({ x: 14, y: 8, width: 6, height: 4, rotation: 0 });
  });

  it("validates layout settings", () => {
    expect(layoutSettingsSchema.safeParse({ width: 60, height: 40, planChannelId: "C087QF130R3", crowdedThreshold: 6 }).success).toBe(true);
    expect(layoutSettingsSchema.safeParse({ width: 60, height: 40, planChannelId: "#biuro", crowdedThreshold: 6 }).success).toBe(false);
    expect(layoutSettingsSchema.safeParse({ width: 5, height: 40, planChannelId: null, crowdedThreshold: 6 }).success).toBe(false);
  });

  it("splits equipment tags", () => {
    expect(splitTags(" usb-c, mac_mini,,usb-c ")).toEqual(["usb-c", "mac_mini"]);
  });
});
