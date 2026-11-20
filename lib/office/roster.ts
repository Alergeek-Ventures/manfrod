import { personKey, type AssignPerson } from "./assign.ts";
import { visitGuests, type GuestVisit, type VisitGuest } from "./visit-guests.ts";

export type RosterPerson = AssignPerson & { slackId: string | null };

export type ManualSeat = { userId: string | null; guestName: string | null; name: string; slackId: string | null };

export type RosterInput = {
  people: { userId: string; name: string | null; slackId: string; status: string }[];
  visits: (GuestVisit & { userIds: string[] })[];
  manual: ManualSeat[];
  memberIds: ReadonlySet<string>;
};

export type Roster = { people: RosterPerson[]; guestList: VisitGuest[] };

export const guestKey = (visitId: string, name: string) => `guest:${visitId}:${name.trim().toLowerCase()}`;

export function dayRoster({ people, visits, manual, memberIds }: RosterInput): Roster {
  const visitGroups = new Map<string, string[]>();
  for (const visit of visits)
    for (const userId of visit.userIds) visitGroups.set(userId, [...(visitGroups.get(userId) ?? []), `visit:${visit.id}`]);
  const present: RosterPerson[] = people
    .filter((person) => person.status === "office")
    .map((person) => ({
      key: personKey({ userId: person.userId, guestName: null }),
      userId: person.userId,
      guestName: null,
      name: person.name ?? person.slackId,
      groups: visitGroups.get(person.userId) ?? [],
      slackId: person.slackId,
    }));
  const keys = new Set(present.map((person) => person.key));
  for (const seat of manual) {
    const key = personKey(seat);
    if (keys.has(key)) continue;
    keys.add(key);
    present.push({
      key,
      userId: seat.userId,
      guestName: seat.userId ? null : seat.guestName,
      name: seat.name,
      groups: seat.userId ? (visitGroups.get(seat.userId) ?? []) : [],
      slackId: seat.slackId,
    });
  }
  const guestList = visitGuests(visits, present, memberIds);
  const guests = guestList.map((guest): RosterPerson => ({
    key: guestKey(guest.visitId, guest.name),
    userId: null,
    guestName: guest.name,
    name: guest.name,
    groups: [`visit:${guest.visitId}`],
    slackId: null,
  }));
  return { people: [...present, ...guests], guestList };
}
