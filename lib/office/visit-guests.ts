import type { OfficeVisit } from "../db/schema.ts";
import { foldName } from "../names.ts";

export type GuestVisit = Pick<OfficeVisit, "id" | "guests" | "guestNames" | "note" | "userIds" | "createdBy">;

export type VisitGuest = { visitId: string; name: string; named: boolean };

export type PresentPerson = { key: string; userId: string | null; name: string | null };

const PLACE = /\bz\s+(\p{Lu}[\p{L}-]*(?:\s+\p{Lu}[\p{L}-]*)?)/u;

export function visitPlace(note: string): string | null {
  return PLACE.exec(note)?.[1] ?? null;
}

export const namedGuestLabel = (name: string) => `${name} (gość)`;

const words = (text: string) =>
  ` ${foldName(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .join(" ")} `;

type Candidate = { key: string; userId: string | null; full: string; first: string };

const sameName = (guest: string, person: Candidate) => {
  const folded = foldName(guest);
  return folded !== "" && (folded === person.full || folded === person.first);
};

const mentioned = (note: string, person: Candidate) =>
  person.first !== "" && (note.includes(` ${person.full} `) || note.includes(` ${person.first} `));

export function visitGuests(visits: GuestVisit[], present: PresentPerson[]): VisitGuest[] {
  const candidates: Candidate[] = present.flatMap((person) => {
    const full = person.name ? foldName(person.name) : "";
    return full ? [{ key: person.key, userId: person.userId, full, first: full.split(" ")[0] }] : [];
  });
  const consumed = new Set<string>();
  const free = (visit: GuestVisit) => (person: Candidate) =>
    !consumed.has(person.key) && !(person.userId && visit.userIds.includes(person.userId));
  const guests: VisitGuest[] = [];
  const used = new Map<string, number>();

  for (const visit of visits) {
    const named = visit.guestNames.slice(0, visit.guests);
    for (const name of named) {
      const match = candidates.filter(free(visit)).find((person) => sameName(name, person));
      if (match) consumed.add(match.key);
      else guests.push({ visitId: visit.id, name: namedGuestLabel(name), named: true });
    }
    let anonymous = visit.guests - named.length;
    const note = words(visit.note);
    for (const person of candidates.filter(free(visit))) {
      if (anonymous === 0) break;
      if (person.userId === visit.createdBy || !mentioned(note, person)) continue;
      consumed.add(person.key);
      anonymous -= 1;
    }
    const place = visitPlace(visit.note);
    const base = place ? `Gość z ${place}` : "Gość";
    for (let index = 0; index < anonymous; index++) {
      const next = (used.get(base) ?? 0) + 1;
      used.set(base, next);
      guests.push({ visitId: visit.id, name: `${base} ${next}`, named: false });
    }
  }
  return guests;
}
