import { existsSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { listReservationsForDate } from "./desks.ts";
import { uploadFile, type SlackResult } from "./slack/api.ts";
import { weekdayName } from "./time.ts";

const escapeXml = (text: string) =>
  text.replace(/[<>&"']/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[char]!);

export function baseImagePath(): string {
  return process.env.DESK_MAP_IMAGE_PATH ?? path.join(process.cwd(), "public", "desk_maps", "office.png");
}

function nameTag(name: string): Buffer {
  const fontSize = 14;
  const width = Math.ceil(name.length * fontSize * 0.62) + 12;
  const height = fontSize + 6 + 4;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <rect width="100%" height="100%" fill="#2F855A" fill-opacity="0.9"/>
      <text x="6" y="${fontSize + 1}" font-family="DejaVu Sans, sans-serif" font-size="${fontSize}" fill="white">${escapeXml(name)}</text>
    </svg>`,
  );
}

function header(text: string): Buffer {
  const fontSize = 22;
  const width = Math.ceil(text.length * fontSize * 0.62) + 4;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${fontSize + 8}">
      <text x="0" y="${fontSize}" font-family="DejaVu Sans, sans-serif" font-size="${fontSize}" fill="black">${escapeXml(text)}</text>
    </svg>`,
  );
}

export async function renderPng(date: string): Promise<Buffer> {
  const imagePath = baseImagePath();
  if (!existsSync(imagePath)) throw new Error(`base_image_not_found: ${imagePath}`);

  const reservations = (await listReservationsForDate(date)).filter(
    (reservation) => reservation.desk.mapX !== null && reservation.desk.mapY !== null,
  );

  const overlays = reservations.map((reservation) => ({
    input: nameTag(reservation.user.name ?? ""),
    left: reservation.desk.mapX!,
    top: reservation.desk.mapY!,
  }));
  overlays.push({ input: header(`Biurka — ${date} (${weekdayName(date)})`), left: 20, top: 15 });

  return sharp(imagePath).composite(overlays).png().toBuffer();
}

export async function postMap(channel: string, date: string): Promise<SlackResult> {
  const png = await renderPng(date);
  return uploadFile(channel, `biurka-${date}.png`, png);
}
