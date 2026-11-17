import { z } from "zod";

export const ELEMENT_KINDS = ["room", "wall", "door", "label"] as const;
export const ROTATIONS = [0, 90, 180, 270] as const;
export const MIN_GRID = 10;
export const MAX_GRID = 400;

export type ElementKind = (typeof ELEMENT_KINDS)[number];
export type Rotation = (typeof ROTATIONS)[number];

const unit = z.number().int().min(0).max(MAX_GRID);
const size = z.number().int().min(1).max(MAX_GRID);
export const rotationSchema = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]);

export const elementSchema = z.object({
  id: z.string().min(1).max(64),
  kind: z.enum(ELEMENT_KINDS),
  x: unit,
  y: unit,
  width: size,
  height: size,
  rotation: rotationSchema.default(0),
  label: z.string().trim().max(80).optional(),
});

export const elementsSchema = z.array(elementSchema).max(500);

export type OfficeElement = z.infer<typeof elementSchema>;

export const layoutSettingsSchema = z.object({
  width: z.number().int().min(MIN_GRID).max(MAX_GRID),
  height: z.number().int().min(MIN_GRID).max(MAX_GRID),
  planChannelId: z
    .string()
    .trim()
    .regex(/^[CG][A-Z0-9]{6,}$/, "must be a Slack channel ID like C087QF130R3")
    .nullable(),
  crowdedThreshold: z.number().int().min(1).max(500),
});

export type LayoutSettings = z.infer<typeof layoutSettingsSchema>;

export const deskGeometrySchema = z.object({
  x: unit.nullable(),
  y: unit.nullable(),
  width: size,
  height: size,
  rotation: rotationSchema,
});

export type DeskGeometry = z.infer<typeof deskGeometrySchema>;

export const deskDetailsSchema = z.object({
  label: z.string().trim().min(1).max(255),
  locationNote: z.string().trim().max(255).nullable(),
  equipment: z.array(z.string().trim().min(1).max(255)).max(30),
  ownerUserId: z.string().uuid().nullable(),
  active: z.boolean(),
});

export type DeskDetails = z.infer<typeof deskDetailsSchema>;

export function parseElements(value: unknown): OfficeElement[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const parsed = elementSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

export type Box = { x: number; y: number; width: number; height: number };

export type Placed = { x: number; y: number; width: number; height: number; rotation: number };

export const isSideways = (rotation: number) => rotation === 90 || rotation === 270;

export function footprint(item: Placed): Box {
  return isSideways(item.rotation)
    ? { x: item.x, y: item.y, width: item.height, height: item.width }
    : { x: item.x, y: item.y, width: item.width, height: item.height };
}

export function doorGeometry(item: Placed) {
  const box = footprint(item);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const left = cx - item.width / 2;
  const bottom = cy + item.height / 2;
  const leaf = item.width;
  return {
    cx,
    cy,
    rotation: item.rotation,
    hinge: { x: left, y: bottom },
    leafEnd: { x: left, y: bottom - leaf },
    closedEnd: { x: left + leaf, y: bottom },
    radius: leaf,
    opening: { x: left, y: bottom, width: leaf },
  };
}

export const nextRotation = (rotation: number): Rotation => ((((rotation + 90) % 360) + 360) % 360) as Rotation;

export function clampToGrid(box: Box, grid: { width: number; height: number }): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(grid.width - box.width, Math.round(box.x))),
    y: Math.max(0, Math.min(grid.height - box.height, Math.round(box.y))),
  };
}

export function fitInside<T extends Placed>(item: T, grid: { width: number; height: number }): T {
  const box = footprint(item);
  const width = Math.min(box.width, grid.width);
  const height = Math.min(box.height, grid.height);
  const { x, y } = clampToGrid({ x: item.x, y: item.y, width, height }, grid);
  return isSideways(item.rotation) ? { ...item, x, y, width: height, height: width } : { ...item, x, y, width, height };
}

export function fitDeskGeometry(desk: DeskGeometry, grid: { width: number; height: number }): DeskGeometry {
  if (desk.x === null || desk.y === null) return desk;
  return fitInside({ ...desk, x: desk.x, y: desk.y }, grid);
}

export const samePlace = (a: Placed, b: Placed) =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height && a.rotation === b.rotation;

export const DEFAULT_SIZES: Record<ElementKind | "desk", { width: number; height: number }> = {
  desk: { width: 6, height: 4 },
  room: { width: 16, height: 12 },
  wall: { width: 12, height: 1 },
  door: { width: 3, height: 3 },
  label: { width: 8, height: 2 },
};

export function splitTags(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag !== ""),
    ),
  ];
}

export function shortName(name: string | null | undefined): string {
  const trimmed = (name ?? "").trim();
  if (trimmed === "") return "?";
  if (trimmed.includes("@")) return trimmed.split("@")[0];
  return trimmed.split(/\s+/)[0];
}

export function shortNames(names: (string | null | undefined)[]): Map<string, string> {
  const result = new Map<string, string>();
  const firsts = new Map<string, number>();
  const unique = [...new Set(names.map((name) => (name ?? "").trim()))];
  for (const name of unique) firsts.set(shortName(name), (firsts.get(shortName(name)) ?? 0) + 1);
  for (const name of unique) {
    const first = shortName(name);
    const parts = name.split(/\s+/);
    result.set(name, (firsts.get(first) ?? 0) > 1 && parts.length > 1 ? `${first} ${parts[1][0]}.` : first);
  }
  return result;
}
