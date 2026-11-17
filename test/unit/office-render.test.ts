import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { MAX_PNG_SIDE, pngScale, renderPng } from "../../lib/office/render.ts";
import { buildMapState } from "../../lib/office/state.ts";
import { canvasSize } from "../../lib/office/svg.ts";

const state = (width: number, height: number) =>
  buildMapState({
    date: "2026-11-17",
    layout: { id: "l", name: "Biuro", width, height, elements: [] },
    desks: [],
    reservations: [],
    awayUserIds: new Set(),
  });

describe("desk map PNG size", () => {
  it("keeps small grids at double density", () => {
    expect(pngScale(canvasSize({ width: 40, height: 30 }))).toBe(2);
  });

  it("scales big grids down to the longest side cap", () => {
    const size = canvasSize({ width: 400, height: 100 });
    expect(Math.round(size.width * pngScale(size))).toBe(MAX_PNG_SIDE);
  });

  it("renders a large office within the cap", async () => {
    const meta = await sharp(await renderPng(state(400, 400))).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(MAX_PNG_SIDE);
  }, 30_000);

  it("renders a small office crisp", async () => {
    const meta = await sharp(await renderPng(state(40, 30))).metadata();
    expect(meta.width).toBe(canvasSize({ width: 40, height: 30 }).width * 2);
  });
});
