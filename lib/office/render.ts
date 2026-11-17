import sharp from "sharp";
import type { MapState } from "./state.ts";
import { canvasSize, renderSvg } from "./svg.ts";

export const MAX_PNG_SIDE = 2400;
const MAX_SCALE = 2;

export function pngScale(size: { width: number; height: number }): number {
  return Math.min(MAX_SCALE, MAX_PNG_SIDE / Math.max(size.width, size.height));
}

export async function renderPng(state: MapState, options: { date?: string; title?: string } = {}): Promise<Buffer> {
  return sharp(Buffer.from(renderSvg(state, options)), { density: 72 * pngScale(canvasSize(state.layout)) })
    .png({ compressionLevel: 9 })
    .toBuffer();
}
