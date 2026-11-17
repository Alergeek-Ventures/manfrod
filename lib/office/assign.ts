import { footprint } from "./model.ts";

export type AssignDesk = {
  id: string;
  label: string;
  active: boolean;
  x: number | null;
  y: number | null;
  width: number;
  height: number;
  rotation: number;
  ownerUserId: string | null;
};

export type AssignPerson = {
  key: string;
  userId: string | null;
  guestName: string | null;
  name: string;
  groups: string[];
};

export type HeldReservation = { deskId: string; userId: string | null; guestName: string | null };

export type AssignReason = "manual" | "owner" | "previous" | "recent" | "cluster";

export type Assignment = {
  deskId: string;
  label: string;
  key: string;
  userId: string | null;
  guestName: string | null;
  name: string;
  reason: AssignReason;
};

export type AssignInput = {
  desks: AssignDesk[];
  people: AssignPerson[];
  awayUserIds: ReadonlySet<string>;
  manual: (HeldReservation & { name: string })[];
  previous?: ReadonlyMap<string, string>;
  recentDesk?: ReadonlyMap<string, string>;
};

export type AssignResult = {
  assignments: Assignment[];
  overflow: AssignPerson[];
  displaced: AssignPerson[];
  freeDeskIds: string[];
};

export const personKey = (person: { userId: string | null; guestName: string | null }) =>
  person.userId ? `user:${person.userId}` : `guest:${(person.guestName ?? "").trim().toLowerCase()}`;

const byLabel = (a: { label: string }, b: { label: string }) => a.label.localeCompare(b.label, "pl", { numeric: true });

type Point = { x: number; y: number };

function center(desk: AssignDesk): Point | null {
  if (desk.x === null || desk.y === null) return null;
  const box = footprint({ x: desk.x, y: desk.y, width: desk.width, height: desk.height, rotation: desk.rotation });
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

function centroid(points: Point[]): Point | null {
  if (points.length === 0) return null;
  return { x: points.reduce((sum, p) => sum + p.x, 0) / points.length, y: points.reduce((sum, p) => sum + p.y, 0) / points.length };
}

const groupOrder = (person: AssignPerson) => [...person.groups].sort()[0] ?? "￿";

export function assignDesks(input: AssignInput): AssignResult {
  const desks = input.desks.filter((desk) => desk.active).sort(byLabel);
  const deskById = new Map(desks.map((desk) => [desk.id, desk]));
  const taken = new Map<string, Assignment>();
  const seated = new Set<string>();
  const assignments: Assignment[] = [];

  const seat = (desk: AssignDesk, person: Pick<AssignPerson, "key" | "userId" | "guestName" | "name">, reason: AssignReason) => {
    const assignment: Assignment = {
      deskId: desk.id,
      label: desk.label,
      key: person.key,
      userId: person.userId,
      guestName: person.guestName,
      name: person.name,
      reason,
    };
    taken.set(desk.id, assignment);
    seated.add(person.key);
    assignments.push(assignment);
  };

  const listed = [...input.people].filter((person, index, all) => all.findIndex((other) => other.key === person.key) === index);
  const comingUsers = new Set(listed.flatMap((person) => (person.userId ? [person.userId] : [])));
  const displaced: AssignPerson[] = [];

  for (const reservation of input.manual) {
    const desk = deskById.get(reservation.deskId);
    const key = personKey(reservation);
    if (!desk || taken.has(desk.id) || seated.has(key)) continue;
    const person = { key, userId: reservation.userId, guestName: reservation.guestName, name: reservation.name };
    if (desk.ownerUserId && desk.ownerUserId !== reservation.userId && comingUsers.has(desk.ownerUserId)) {
      displaced.push(listed.find((candidate) => candidate.key === key) ?? { ...person, groups: [] });
      continue;
    }
    seat(desk, person, "manual");
  }

  const people = [...listed, ...displaced.filter((person) => !listed.some((other) => other.key === person.key))];
  const coming = new Set(people.map((person) => person.key));

  for (const desk of desks) {
    if (!desk.ownerUserId || taken.has(desk.id)) continue;
    const owner = people.find((person) => person.userId === desk.ownerUserId);
    if (owner && !seated.has(owner.key)) seat(desk, owner, "owner");
  }

  const usable = (desk: AssignDesk) => {
    if (taken.has(desk.id)) return false;
    if (!desk.ownerUserId) return true;
    return input.awayUserIds.has(desk.ownerUserId) && !coming.has(`user:${desk.ownerUserId}`);
  };

  const waiting = people.filter((person) => !seated.has(person.key));

  for (const [reason, preferred] of [
    ["previous", input.previous],
    ["recent", input.recentDesk],
  ] as const) {
    if (!preferred) continue;
    for (const person of waiting) {
      if (seated.has(person.key)) continue;
      const desk = deskById.get(preferred.get(person.key) ?? "");
      if (desk && usable(desk)) seat(desk, person, reason);
    }
  }

  const rest = waiting
    .filter((person) => !seated.has(person.key))
    .sort(
      (a, b) =>
        groupOrder(a).localeCompare(groupOrder(b)) ||
        Number(a.userId === null) - Number(b.userId === null) ||
        a.name.localeCompare(b.name, "pl", { numeric: true }) ||
        a.key.localeCompare(b.key),
    );
  const overflow: AssignPerson[] = [];
  const groupsOf = new Map(people.map((person) => [person.key, new Set(person.groups)]));

  for (const person of rest) {
    const free = desks.filter(usable);
    if (free.length === 0) {
      overflow.push(person);
      continue;
    }
    const occupied = [...taken.values()];
    const teammates = occupied.filter((assignment) => person.groups.some((group) => groupsOf.get(assignment.key)?.has(group)));
    const anchor =
      centroid(teammates.flatMap((assignment) => center(deskById.get(assignment.deskId)!) ?? [])) ??
      centroid(occupied.flatMap((assignment) => center(deskById.get(assignment.deskId)!) ?? []));
    const score = (desk: AssignDesk) => {
      const point = center(desk);
      if (!point) return Number.POSITIVE_INFINITY;
      return anchor ? distance(point, anchor) : point.x + point.y;
    };
    const best = [...free].sort((a, b) => score(a) - score(b) || byLabel(a, b))[0];
    seat(best, person, "cluster");
  }

  return {
    assignments: assignments.sort((a, b) => byLabel(a, b)),
    overflow,
    displaced,
    freeDeskIds: desks.filter(usable).map((desk) => desk.id),
  };
}

export function seatingSignature(result: Pick<AssignResult, "assignments" | "overflow">): string {
  const seats = result.assignments.map((assignment) => `${assignment.deskId}=${assignment.key}`).sort();
  const overflow = result.overflow.map((person) => person.key).sort();
  return JSON.stringify([seats, overflow]);
}

export function guestNames(visits: { note: string; guests: number }[]): string[] {
  const names: string[] = [];
  const used = new Map<string, number>();
  for (const visit of visits) {
    if (visit.guests <= 0) continue;
    const base = guestBase(visit.note);
    for (let index = 0; index < visit.guests; index++) {
      const next = (used.get(base) ?? 0) + 1;
      used.set(base, next);
      names.push(`${base} ${next}`);
    }
  }
  return names;
}

const PLACE = /\bz\s+(\p{Lu}[\p{L}-]*(?:\s+\p{Lu}[\p{L}-]*)?)/u;

export function guestBase(note: string): string {
  const place = PLACE.exec(note);
  if (place) return `Gość z ${place[1]}`;
  const short = note.trim().split(/\s+/).slice(0, 3).join(" ");
  return short ? `Gość (${short})` : "Gość";
}
