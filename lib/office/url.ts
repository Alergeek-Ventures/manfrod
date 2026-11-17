import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "../config.ts";
import { isValidIsoDate } from "../time.ts";

const sign = (date: string, version: string) =>
  createHmac("sha256", config.internalApiSecret).update(`desk-map:${date}:${version}`).digest("base64url");

export function deskMapPath(date: string, version: number | string): string {
  const v = String(version);
  return `/desk-map/${date}.png?v=${encodeURIComponent(v)}&sig=${sign(date, v)}`;
}

export function deskMapUrl(date: string, version: number | string): string {
  return `${config.appUrl}${deskMapPath(date, version)}`;
}

export function verifyDeskMapSignature(date: string, version: string | null, signature: string | null): boolean {
  if (!isValidIsoDate(date) || !version || !signature) return false;
  const expected = Buffer.from(sign(date, version));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function dateFromMapFile(file: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})\.png$/.exec(file);
  return match && isValidIsoDate(match[1]) ? match[1] : null;
}
