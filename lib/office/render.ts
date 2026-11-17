import sharp from "sharp";
import type { MapState } from "./state.ts";
import { renderSvg } from "./svg.ts";

export async function renderPng(state: MapState, options: { date?: string; title?: string } = {}): Promise<Buffer> {
  return sharp(Buffer.from(renderSvg(state, options)), { density: 144 })
    .png({ compressionLevel: 9 })
    .toBuffer();
}
