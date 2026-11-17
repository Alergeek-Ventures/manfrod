import { asc, eq, sql } from "drizzle-orm";
import type { z } from "zod";
import { db, tables } from "../db/index.ts";
import type { Desk, OfficeLayout } from "../db/schema.ts";
import {
  deskDetailsSchema,
  deskGeometrySchema,
  elementsSchema,
  layoutSettingsSchema,
  parseElements,
  type DeskDetails,
  type DeskGeometry,
  type LayoutSettings,
  type OfficeElement,
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

export async function getLayout(): Promise<Layout> {
  const [existing] = await db.select().from(officeLayouts).orderBy(asc(officeLayouts.updatedAt)).limit(1);
  if (existing) return toLayout(existing);
  const [created] = await db.insert(officeLayouts).values({ name: "Biuro" }).returning();
  return toLayout(created);
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
  await db
    .update(officeLayouts)
    .set({ elements: parsed, updatedAt: sql`timezone('UTC'::text, now())` })
    .where(eq(officeLayouts.id, layoutId));
  return parsed;
}

export async function saveLayoutSettings(layoutId: string, settings: LayoutSettings): Promise<Layout> {
  const parsed = parse(layoutSettingsSchema, settings);
  const [updated] = await db
    .update(officeLayouts)
    .set({ ...parsed, updatedAt: sql`timezone('UTC'::text, now())` })
    .where(eq(officeLayouts.id, layoutId))
    .returning();
  if (!updated) throw new OfficeError("layout not found");
  return toLayout(updated);
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

export async function createDesk(input: DeskInput): Promise<Desk> {
  const values = validPatch(input);
  const layout = await getLayout();
  return writeDesk(async () => {
    const [desk] = await db
      .insert(desks)
      .values({ ...values, label: values.label!, layoutId: layout.id })
      .returning();
    return desk;
  }, values.label);
}

export async function updateDesk(deskId: string, patch: DeskPatch): Promise<Desk> {
  const values = validPatch(patch);
  if (Object.keys(values).length === 0) {
    const [desk] = await db.select().from(desks).where(eq(desks.id, deskId)).limit(1);
    if (!desk) throw new OfficeError("desk not found");
    return desk;
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
