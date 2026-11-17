import { and, asc, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { z } from "zod";
import { db, tables } from "../db/index.ts";
import type { Desk, OfficeLayout } from "../db/schema.ts";
import {
  DEFAULT_SIZES,
  deskDetailsSchema,
  deskGeometrySchema,
  elementsSchema,
  fitDeskGeometry,
  fitInside,
  layoutSettingsSchema,
  parseElements,
  type DeskDetails,
  type DeskGeometry,
  type LayoutSettings,
  type OfficeElement,
  samePlace,
} from "./model.ts";

const { desks, officeLayouts, users } = tables;

export class OfficeError extends Error {}

export type Layout = Omit<OfficeLayout, "elements"> & { elements: OfficeElement[] };
export type DeskWithOwner = Desk & { ownerName: string | null };
export type Office = { layout: Layout; desks: DeskWithOwner[] };

const toLayout = (row: OfficeLayout): Layout => ({ ...row, elements: parseElements(row.elements) });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new OfficeError(result.error.issues.map((issue) => `${issue.path.map(String).join(".") || "value"}: ${issue.message}`).join(", "));
}

const LAYOUT_LOCK = 4_208_311;

const selectLayout = (executor: Pick<typeof db, "select">) =>
  executor
    .select()
    .from(officeLayouts)
    .orderBy(desc(sql`exists (select 1 from ${desks} where ${desks.layoutId} = ${officeLayouts.id})`), asc(officeLayouts.id))
    .limit(1);

export async function getLayout(): Promise<Layout> {
  const [existing] = await selectLayout(db);
  if (existing) return toLayout(existing);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${LAYOUT_LOCK})`);
    const [raced] = await selectLayout(tx);
    if (raced) return toLayout(raced);
    const [created] = await tx.insert(officeLayouts).values({ name: "Biuro" }).returning();
    return toLayout(created);
  });
}

async function getLayoutById(layoutId: string): Promise<Layout> {
  const [row] = await db.select().from(officeLayouts).where(eq(officeLayouts.id, layoutId)).limit(1);
  if (!row) throw new OfficeError("layout not found");
  return toLayout(row);
}

export async function listDesksWithOwners(opts: { includeInactive?: boolean } = {}): Promise<DeskWithOwner[]> {
  const rows = await db
    .select({ desk: desks, ownerName: users.name })
    .from(desks)
    .leftJoin(users, eq(users.id, desks.ownerUserId))
    .where(opts.includeInactive ? undefined : eq(desks.active, true))
    .orderBy(asc(desks.label));
  return rows
    .map((row) => ({ ...row.desk, ownerName: row.ownerName }))
    .sort((a, b) => a.label.localeCompare(b.label, "pl", { numeric: true }));
}

export async function loadOffice(opts: { includeInactive?: boolean } = {}): Promise<Office> {
  const [layout, deskRows] = await Promise.all([getLayout(), listDesksWithOwners(opts)]);
  return { layout, desks: deskRows.filter((desk) => desk.layoutId === layout.id) };
}

export async function saveElements(layoutId: string, elements: unknown): Promise<OfficeElement[]> {
  const parsed = parse(elementsSchema, elements);
  if (new Set(parsed.map((element) => element.id)).size !== parsed.length) throw new OfficeError("elements: ids must be unique");
  const layout = await getLayoutById(layoutId);
  const fitted = parsed.map((element) => fitInside(element, layout));
  await db
    .update(officeLayouts)
    .set({ elements: fitted, updatedAt: sql`timezone('UTC'::text, now())` })
    .where(eq(officeLayouts.id, layoutId));
  return fitted;
}

export async function saveLayoutSettings(layoutId: string, settings: LayoutSettings): Promise<Layout> {
  const parsed = parse(layoutSettingsSchema, settings);
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(officeLayouts)
      .set({ ...parsed, updatedAt: sql`timezone('UTC'::text, now())` })
      .where(eq(officeLayouts.id, layoutId))
      .returning();
    if (!updated) throw new OfficeError("layout not found");
    const layout = toLayout(updated);
    const elements = layout.elements.map((element) => fitInside(element, layout));
    if (elements.some((element, index) => !samePlace(element, layout.elements[index])))
      await tx.update(officeLayouts).set({ elements }).where(eq(officeLayouts.id, layoutId));
    const placed = await tx
      .select()
      .from(desks)
      .where(and(eq(desks.layoutId, layoutId), isNotNull(desks.x), isNotNull(desks.y)));
    for (const desk of placed) {
      const current = { x: desk.x!, y: desk.y!, width: desk.width, height: desk.height, rotation: desk.rotation };
      const fitted = fitInside(current, layout);
      if (!samePlace(fitted, current))
        await tx
          .update(desks)
          .set({ ...fitted, updatedAt: sql`timezone('UTC'::text, now())` })
          .where(eq(desks.id, desk.id));
    }
    return { ...layout, elements };
  });
}

export type DeskInput = Partial<DeskDetails> & Partial<DeskGeometry> & { label: string };
export type DeskPatch = Partial<DeskDetails> & Partial<DeskGeometry>;

const detailsPatch = deskDetailsSchema.partial();
const geometryPatch = deskGeometrySchema.partial();

function validPatch(patch: DeskPatch): DeskPatch {
  const details = parse(detailsPatch, pick(patch, ["label", "locationNote", "equipment", "ownerUserId", "active"]));
  const geometry = parse(geometryPatch, pick(patch, ["x", "y", "width", "height", "rotation"]));
  return { ...details, ...geometry };
}

function pick<T extends object, K extends keyof T>(value: T, keys: K[]): Partial<Pick<T, K>> {
  return Object.fromEntries(keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]])) as Partial<Pick<T, K>>;
}

async function writeDesk<T>(run: () => Promise<T>, label: string | undefined): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const message = (error as { cause?: { code?: string }; code?: string }).cause?.code ?? (error as { code?: string }).code;
    if (message === "23505") throw new OfficeError(`label: desk '${label}' already exists`);
    throw error;
  }
}

const GEOMETRY_KEYS = ["x", "y", "width", "height", "rotation"] as const;

function mergedGeometry(current: DeskGeometry, patch: DeskPatch, grid: { width: number; height: number }): DeskGeometry {
  const { x, y, width, height, rotation } = { ...current, ...pick(patch, [...GEOMETRY_KEYS]) };
  return fitDeskGeometry({ x, y, width, height, rotation: rotation as DeskGeometry["rotation"] }, grid);
}

export async function createDesk(input: DeskInput): Promise<Desk> {
  const values = validPatch(input);
  const layout = await getLayout();
  const geometry = mergedGeometry({ x: null, y: null, ...DEFAULT_SIZES.desk, rotation: 0 }, values, layout);
  return writeDesk(async () => {
    const [desk] = await db
      .insert(desks)
      .values({ ...values, ...geometry, label: values.label!, layoutId: layout.id })
      .returning();
    return desk;
  }, values.label);
}

export async function updateDesk(deskId: string, patch: DeskPatch): Promise<Desk> {
  let values = validPatch(patch);
  const movesDesk = GEOMETRY_KEYS.some((key) => values[key] !== undefined);
  if (Object.keys(values).length === 0 || movesDesk) {
    const [current] = await db.select().from(desks).where(eq(desks.id, deskId)).limit(1);
    if (!current) throw new OfficeError("desk not found");
    if (!movesDesk) return current;
    const layout = await getLayoutById(current.layoutId);
    values = { ...values, ...mergedGeometry(current as Desk & DeskGeometry, values, layout) };
  }
  return writeDesk(async () => {
    const [desk] = await db
      .update(desks)
      .set({ ...values, updatedAt: sql`timezone('UTC'::text, now())` })
      .where(eq(desks.id, deskId))
      .returning();
    if (!desk) throw new OfficeError("desk not found");
    return desk;
  }, values.label);
}

export async function deleteDesk(deskId: string): Promise<boolean> {
  const result = await db.delete(desks).where(eq(desks.id, deskId));
  return (result.rowCount ?? 0) > 0;
}
