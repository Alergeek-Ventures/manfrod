import { weekdayName } from "../time.ts";
import { footprint, isSideways, type Box, type OfficeElement } from "./model.ts";
import { DESK_STATUSES, placedDesks, type DeskStatus, type MapState, type PlacedDesk } from "./state.ts";

export const UNIT = 20;
const PAD = 32;
const HEADER = 84;
const LEGEND = 56;
const FONT = "DejaVu Sans, Inter, Helvetica, Arial, sans-serif";

export const STATUS_STYLE: Record<DeskStatus, { fill: string; stroke: string; text: string; legend: string; dashed?: boolean }> = {
  owner_present: { fill: "#E2E8F0", stroke: "#64748B", text: "#1E293B", legend: "Właściciel w biurze" },
  owner_away: { fill: "#FEF3C7", stroke: "#D97706", text: "#78350F", legend: "Właściciel nieobecny – wolne", dashed: true },
  taken: { fill: "#DBEAFE", stroke: "#2563EB", text: "#1E3A8A", legend: "Zajęte" },
  free: { fill: "#DCFCE7", stroke: "#16A34A", text: "#14532D", legend: "Wolne" },
};

const WEEKDAYS_PL: Record<string, string> = {
  Monday: "poniedziałek",
  Tuesday: "wtorek",
  Wednesday: "środa",
  Thursday: "czwartek",
  Friday: "piątek",
  Saturday: "sobota",
  Sunday: "niedziela",
};

const MONTHS_PL = [
  "stycznia",
  "lutego",
  "marca",
  "kwietnia",
  "maja",
  "czerwca",
  "lipca",
  "sierpnia",
  "września",
  "października",
  "listopada",
  "grudnia",
];

export function polishDate(dateIso: string): string {
  const [year, month, day] = dateIso.split("-").map(Number);
  return `${WEEKDAYS_PL[weekdayName(dateIso)]}, ${day} ${MONTHS_PL[month - 1]} ${year}`;
}

export const escapeXml = (text: string) =>
  text.replace(/[<>&"']/g, (char) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[char]!);

const px = (value: number) => Math.round(value * 100) / 100;

export function freeDesks(count: number): string {
  if (count === 1) return "1 wolne biurko";
  const tens = count % 100;
  const few = count % 10 >= 2 && count % 10 <= 4 && (tens < 12 || tens > 14);
  return `${count} ${few ? "wolne biurka" : "wolnych biurek"}`;
}

export function wrapText(content: string, maxWidth: number, fontSize: number): string[] {
  if (fitText(content, maxWidth, fontSize) === content) return [content];
  const words = content.split(/\s+/);
  if (words.length < 2) return [fitText(content, maxWidth, fontSize)];
  const first: string[] = [];
  while (words.length > 1 && fitText([...first, words[0]].join(" "), maxWidth, fontSize) === [...first, words[0]].join(" "))
    first.push(words.shift()!);
  if (first.length === 0) first.push(words.shift()!);
  return [fitText(first.join(" "), maxWidth, fontSize), fitText(words.join(" "), maxWidth, fontSize)];
}

export function fitText(text: string, maxWidth: number, fontSize: number): string {
  const max = Math.floor(maxWidth / (fontSize * 0.6));
  if (text.length <= max) return text;
  if (max <= 1) return "…";
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function text(
  x: number,
  y: number,
  content: string,
  attrs: { size: number; fill: string; weight?: number; anchor?: "start" | "middle" | "end"; extra?: string },
): string {
  return `<text x="${px(x)}" y="${px(y)}" font-family="${FONT}" font-size="${attrs.size}" font-weight="${attrs.weight ?? 400}" fill="${attrs.fill}" text-anchor="${attrs.anchor ?? "start"}" dominant-baseline="central"${attrs.extra ? ` ${attrs.extra}` : ""}>${escapeXml(content)}</text>`;
}

function scaled(box: Box, originX: number, originY: number): Box {
  return { x: originX + box.x * UNIT, y: originY + box.y * UNIT, width: box.width * UNIT, height: box.height * UNIT };
}

function room(element: OfficeElement, box: Box): string {
  const label = element.label
    ? text(box.x + 10, box.y + 14, fitText(element.label.toUpperCase(), box.width - 20, 11), {
        size: 11,
        fill: "#64748B",
        weight: 700,
        extra: 'letter-spacing="0.6"',
      })
    : "";
  return `<rect x="${px(box.x)}" y="${px(box.y)}" width="${px(box.width)}" height="${px(box.height)}" rx="10" fill="#F1F5F9" stroke="#CBD5E1" stroke-width="1.5"/>${label}`;
}

function wall(box: Box): string {
  return `<rect x="${px(box.x)}" y="${px(box.y)}" width="${px(box.width)}" height="${px(box.height)}" rx="2" fill="#334155"/>`;
}

function door(element: OfficeElement, box: Box): string {
  const size = Math.min(box.width, box.height);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const left = cx - size / 2;
  const top = cy - size / 2;
  return `<g transform="rotate(${element.rotation} ${px(cx)} ${px(cy)})">
<rect x="${px(left)}" y="${px(top + size - 1)}" width="${px(size)}" height="${UNIT + 2}" fill="#FFFFFF"/>
<path d="M ${px(left)} ${px(top)} A ${px(size)} ${px(size)} 0 0 1 ${px(left + size)} ${px(top + size)}" fill="none" stroke="#94A3B8" stroke-width="1.5" stroke-dasharray="4 3"/>
<line x1="${px(left)}" y1="${px(top + size)}" x2="${px(left)}" y2="${px(top)}" stroke="#475569" stroke-width="3" stroke-linecap="round"/>
</g>`;
}

function label(element: OfficeElement, box: Box): string {
  if (!element.label) return "";
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const sideways = isSideways(element.rotation);
  const length = sideways ? box.height : box.width;
  const rotate = sideways ? `transform="rotate(${element.rotation === 90 ? 90 : -90} ${px(cx)} ${px(cy)})"` : "";
  return text(cx, cy, fitText(element.label, length - 8, 14), { size: 14, fill: "#475569", weight: 700, anchor: "middle", extra: rotate });
}

export function seatSide(rotation: number): "bottom" | "left" | "top" | "right" {
  return ({ 0: "bottom", 90: "left", 180: "top", 270: "right" } as const)[rotation as 0 | 90 | 180 | 270] ?? "bottom";
}

function deskShape(desk: PlacedDesk, box: Box): string {
  const style = STATUS_STYLE[desk.status];
  const side = seatSide(desk.rotation);
  const chair = UNIT * 0.45;
  const horizontal = side === "top" || side === "bottom";
  const seat = {
    bottom: { cx: box.x + box.width / 2, cy: box.y + box.height },
    top: { cx: box.x + box.width / 2, cy: box.y },
    left: { cx: box.x, cy: box.y + box.height / 2 },
    right: { cx: box.x + box.width, cy: box.y + box.height / 2 },
  }[side];

  const lines: string[] = [];
  const innerWidth = box.width - 12;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const nameSize = desk.name && desk.name.length > 9 ? 13 : 15;
  const main =
    desk.status === "free" || desk.status === "owner_away"
      ? { content: "wolne", size: 14, weight: 600 }
      : { content: desk.name ?? "", size: nameSize, weight: 700 };
  const sub =
    desk.status === "owner_away" && desk.name
      ? `${desk.name} poza biurem`
      : desk.status === "free" && desk.equipment.length > 0
        ? desk.equipment.join(", ")
        : null;
  const labelY = horizontal && side === "top" ? box.y + box.height - 12 : box.y + 13;
  const offset = sub ? -2 : 4;
  lines.push(
    text(box.x + 8, labelY, fitText(desk.label, innerWidth, 11), { size: 11, fill: style.text, weight: 700, extra: 'opacity="0.75"' }),
  );
  const mainLines = wrapText(main.content, innerWidth, main.size);
  mainLines.forEach((line, index) =>
    lines.push(
      text(cx, cy + offset + (index - (mainLines.length - 1) / 2) * (main.size + 2), line, {
        size: main.size,
        fill: style.text,
        weight: main.weight,
        anchor: "middle",
      }),
    ),
  );
  if (sub)
    lines.push(
      text(cx, cy + offset + 16, fitText(sub, innerWidth, 10), { size: 10, fill: style.text, anchor: "middle", extra: 'opacity="0.8"' }),
    );

  return `<g data-desk="${escapeXml(desk.label)}" data-status="${desk.status}">
<circle cx="${px(seat.cx)}" cy="${px(seat.cy)}" r="${px(chair)}" fill="#FFFFFF" stroke="${style.stroke}" stroke-width="1.5"/>
<rect x="${px(box.x)}" y="${px(box.y)}" width="${px(box.width)}" height="${px(box.height)}" rx="8" fill="${style.fill}" stroke="${style.stroke}" stroke-width="2"${style.dashed ? ' stroke-dasharray="6 4"' : ""}/>
${lines.join("\n")}
</g>`;
}

export function deskBox(desk: PlacedDesk, originX = 0, originY = 0): Box {
  return scaled(footprint(desk), originX, originY);
}

function legend(state: MapState, y: number): string {
  const desks = placedDesks(state);
  const counts = new Map(DESK_STATUSES.map((status) => [status, desks.filter((desk) => desk.status === status).length]));
  let x = PAD;
  return DESK_STATUSES.map((status) => {
    const style = STATUS_STYLE[status];
    const caption = `${style.legend} (${counts.get(status)})`;
    const chunk = `<rect x="${px(x)}" y="${y - 8}" width="16" height="16" rx="4" fill="${style.fill}" stroke="${style.stroke}" stroke-width="2"${style.dashed ? ' stroke-dasharray="4 2"' : ""}/>${text(x + 24, y, caption, { size: 13, fill: "#334155" })}`;
    x += 24 + caption.length * 13 * 0.56 + 28;
    return chunk;
  }).join("\n");
}

export function renderSvg(state: MapState, options: { date?: string; title?: string } = {}): string {
  const date = options.date ?? state.date;
  const mapWidth = state.layout.width * UNIT;
  const mapHeight = state.layout.height * UNIT;
  const width = Math.max(mapWidth + PAD * 2, 880);
  const height = HEADER + mapHeight + LEGEND + PAD;
  const originX = (width - mapWidth) / 2;
  const originY = HEADER;
  const desks = placedDesks(state);
  const free = desks.filter((desk) => desk.status === "free" || desk.status === "owner_away").length;

  const order: Record<OfficeElement["kind"], number> = { room: 0, wall: 1, door: 2, label: 3 };
  const elements = [...state.layout.elements]
    .sort((a, b) => order[a.kind] - order[b.kind])
    .map((element) => {
      const box = scaled(footprint(element), originX, originY);
      if (element.kind === "room") return room(element, box);
      if (element.kind === "wall") return wall(box);
      if (element.kind === "door") return door(element, box);
      return label(element, box);
    });

  const dots: string[] = [];
  for (let gx = 0; gx <= state.layout.width; gx += 2)
    for (let gy = 0; gy <= state.layout.height; gy += 2) dots.push(`M${originX + gx * UNIT} ${originY + gy * UNIT}h0`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="${width}" height="${height}" fill="#F8FAFC"/>
${text(PAD, 34, options.title ?? `Biurka · ${state.layout.name}`, { size: 22, fill: "#0F172A", weight: 700 })}
${text(PAD, 60, polishDate(date), { size: 15, fill: "#475569" })}
${text(width - PAD, 34, `${freeDesks(free)}`, { size: 15, fill: "#0F172A", weight: 700, anchor: "end" })}
${text(width - PAD, 60, `${desks.length} na mapie`, { size: 13, fill: "#64748B", anchor: "end" })}
<rect x="${originX - 8}" y="${originY - 8}" width="${mapWidth + 16}" height="${mapHeight + 16}" rx="14" fill="#FFFFFF" stroke="#E2E8F0"/>
<path d="${dots.join("")}" stroke="#E2E8F0" stroke-width="2" stroke-linecap="round"/>
${elements.join("\n")}
${desks.map((desk) => deskShape(desk, deskBox(desk, originX, originY))).join("\n")}
${legend(state, HEADER + mapHeight + 8 + LEGEND / 2)}
</svg>`;
}
