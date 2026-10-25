import { asc } from "drizzle-orm";
import { db, tables } from "../db/index.ts";
import type { Project } from "../db/schema.ts";

export async function listProjects(): Promise<Project[]> {
  return db.select().from(tables.projects).orderBy(asc(tables.projects.name));
}

export async function findProject(query: string): Promise<Project | null> {
  const needle = query.trim().toLowerCase();
  if (needle === "") return null;
  const projects = await listProjects();
  return (
    projects.find((p) => p.slug.toLowerCase() === needle || p.name.toLowerCase() === needle) ??
    projects.find((p) => p.name.toLowerCase().includes(needle)) ??
    null
  );
}

export function unknownProjectMessage(name: string | null | undefined): string {
  return `Nie znalazłem projektu "${name ?? ""}" — sprawdź listę przez list_projects.`;
}
