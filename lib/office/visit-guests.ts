import type { OfficeVisit } from "../db/schema.ts";
import { foldName } from "../names.ts";

export type GuestVisit = Pick<OfficeVisit, "id" | "guests" | "guestNames" | "note" | "userIds">;

export type VisitGuest = { visitId: string; name: string; named: boolean };

export type PresentPerson = { key: string; userId: string | null; name: string | null };

const PLACE = /\bz\s+(\p{Lu}[\p{L}-]*(?:\s+\p{Lu}[\p{L}-]*)?)/u;

export function visitPlace(note: string): string | null {
  return PLACE.exec(note)?.[1] ?? null;
}

export const namedGuestLabel = (name: string) => `${name} (gość)`;

type Candidate = { key: string; userId: string | null; full: string; first: string; member: boolean };

function seatedAs(guest: string, candidates: Candidate[]): Candidate | null {
  const folded = foldName(guest);
  if (folded === "") return null;
  const full = candidates.find((person) => person.full === folded);
  if (full) return full;
  if (folded.includes(" ")) return null;
  const byFirst = candidates.filter((person) => !person.member && person.first === folded);
  return byFirst.length === 1 ? byFirst[0] : null;
}

export function visitGuests(visits: GuestVisit[], present: PresentPerson[], memberIds: ReadonlySet<string> = new Set()): VisitGuest[] {
  const candidates: Candidate[] = present.flatMap((person) => {
    const full = person.name ? foldName(person.name) : "";
    if (!full) return [];
    return [
      {
        key: person.key,
        userId: person.userId,
        full,
        first: full.split(" ")[0],
        member: Boolean(person.userId && memberIds.has(person.userId)),
      },
    ];
  });
  const consumed = new Set<string>();
  const emitted = new Set<string>();
  const guests: VisitGuest[] = [];
  const used = new Map<string, number>();

  for (const visit of visits) {
    const named = visit.guestNames.slice(0, visit.guests);
    const free = candidates.filter((person) => !consumed.has(person.key) && !(person.userId && visit.userIds.includes(person.userId)));
    for (const name of named) {
      const match = seatedAs(
        name,
        free.filter((person) => !consumed.has(person.key)),
      );
      if (match) {
        consumed.add(match.key);
        continue;
      }
      const label = namedGuestLabel(name);
      if (emitted.has(foldName(label))) continue;
      emitted.add(foldName(label));
      guests.push({ visitId: visit.id, name: label, named: true });
    }
    const place = visitPlace(visit.note);
    const base = place ? `Gość z ${place}` : "Gość";
    for (let index = 0; index < visit.guests - named.length; index++) {
      const next = (used.get(base) ?? 0) + 1;
      used.set(base, next);
      guests.push({ visitId: visit.id, name: `${base} ${next}`, named: false });
    }
  }
  return guests;
}
