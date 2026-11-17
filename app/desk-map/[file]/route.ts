import type { NextRequest } from "next/server";
import { logger } from "@/lib/log.ts";
import { renderDeskMapPng } from "@/lib/office/map.ts";
import { dateFromMapFile, verifyDeskMapSignature } from "@/lib/office/url.ts";

const log = logger("DeskMap.Route");

export async function GET(request: NextRequest, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  const date = dateFromMapFile(file);
  if (!date) return new Response("Not found.", { status: 404 });
  const { searchParams } = request.nextUrl;
  if (!verifyDeskMapSignature(date, searchParams.get("v"), searchParams.get("sig"))) return new Response("Forbidden.", { status: 403 });
  try {
    const png = await renderDeskMapPng(date);
    return new Response(new Uint8Array(png), {
      headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=60, must-revalidate" },
    });
  } catch (error) {
    log.error(`DeskMap.Route: rendering ${date} failed: ${(error as Error).message}`);
    return new Response("Failed to render the map.", { status: 500 });
  }
}
