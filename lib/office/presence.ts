import type { OfficeVisit } from "../db/schema.ts";
import { localToday } from "../time.ts";
import { isConfirmedAway } from "./away.ts";
import { fetchFirmowidSignals } from "./presence-firmowid.ts";
import { habitWindowStart, resolvePresence, type PresenceResolution, type StatedStatus } from "./presence-resolve.ts";
import {
  loadAbsences,
  loadDeskOwners,
  loadExplicit,
  loadManualSeats,
  loadMembers,
  loadPeople,
  loadReservationDates,
  loadStatedOffice,
  type PersonRef,
} from "./presence-sources.ts";
import { defaultLayoutId, listVisits } from "./presence-store.ts";
import { dayRoster, type RosterPerson } from "./roster.ts";
import type { VisitGuest } from "./visit-guests.ts";

export { resolvePresence } from "./presence-resolve.ts";
export type { PresenceResolution, PresenceSignals, PresenceStatus, StatedStatus } from "./presence-resolve.ts";
export {
  cancelVisit,
  clearPresence,
  defaultLayoutId,
  getVisit,
  listVisits,
  recordVisit,
  setPresence,
  updateVisit,
} from "./presence-store.ts";

export const FIRMOWID_CONCURRENCY = 4;

export type PersonPresence = PersonRef & PresenceResolution;

export interface OfficeDayPrediction {
  date: string;
  layoutId: string | null;
  people: PersonPresence[];
  visits: OfficeVisit[];
  roster: RosterPerson[];
  guestList: VisitGuest[];
  guests: number;
  expectedInOffice: number;
}

async function mapLimited<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

const STATUS_ORDER = { office: 0, remote: 1, leave: 2, unknown: 3 };

export async function predictOfficeDay(date: string, opts: { layoutId?: string; today?: string } = {}): Promise<OfficeDayPrediction> {
  const today = opts.today ?? localToday();
  const layoutId = opts.layoutId ?? (await defaultLayoutId());
  if (!layoutId) return { date, layoutId: null, people: [], visits: [], roster: [], guestList: [], guests: 0, expectedInOffice: 0 };

  const [members, visits, stated, manual, owners] = await Promise.all([
    loadMembers(layoutId),
    listVisits(date, date, { layoutId }),
    loadStatedOffice(date),
    loadManualSeats(layoutId, date),
    loadDeskOwners(layoutId),
  ]);
  const memberIds = new Set(members.map((member) => member.userId));
  const visitByUser = new Map<string, OfficeVisit>();
  for (const visit of visits) for (const userId of visit.userIds) if (!visitByUser.has(userId)) visitByUser.set(userId, visit);
  const visitors = await loadPeople([...visitByUser.keys()].filter((userId) => !memberIds.has(userId)));
  const known = new Set([...memberIds, ...visitors.map((person) => person.userId)]);
  const others = [...owners, ...stated].filter(
    (person, index, all) => !known.has(person.userId) && all.findIndex((other) => other.userId === person.userId) === index,
  );
  const people = [...members, ...visitors, ...others];
  const ids = people.map((person) => person.userId);
  const from = habitWindowStart(date, today);

  const [explicit, absences, reservations, firmowid] = await Promise.all([
    loadExplicit(ids, date),
    loadAbsences(ids, date),
    loadReservationDates(layoutId, ids, from, date),
    mapLimited(people, FIRMOWID_CONCURRENCY, (person) => fetchFirmowidSignals(person.userId, from, date)),
  ]);
  const explicitByUser = new Map(explicit.map((row) => [row.userId, row]));

  const predicted = people.map((person, index): PersonPresence => {
    const stated = explicitByUser.get(person.userId);
    const reserved = reservations.get(person.userId) ?? [];
    const visit = visitByUser.get(person.userId);
    const resolution = resolvePresence({
      date,
      today,
      explicit: stated ? { status: stated.status as StatedStatus, source: stated.source, note: stated.note } : null,
      leaveRequests: firmowid[index].leaveRequests ?? [],
      absences: absences.get(person.userId) ?? [],
      visit: visit ? { note: visit.note } : null,
      sessionDays: firmowid[index].sessionDays ?? [],
      reservedThatDay: reserved.includes(date),
      reservationDates: reserved,
    });
    return { ...person, ...resolution };
  });
  predicted.sort(
    (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.confidence - a.confidence || (a.name ?? "").localeCompare(b.name ?? ""),
  );

  const away = new Set(predicted.filter(isConfirmedAway).map((person) => person.userId));
  const ownerIds = new Set(owners.map((owner) => owner.userId));
  const roster = dayRoster({ people: predicted, visits, manual, memberIds, away, ownerIds });
  return {
    date,
    layoutId,
    people: predicted,
    visits,
    roster: roster.people,
    guestList: roster.guestList,
    guests: roster.guestList.length,
    expectedInOffice: roster.people.length,
  };
}
