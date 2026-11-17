import type { OfficeVisit } from "../db/schema.ts";
import { withWeekday } from "../time.ts";
import type { OfficeDayPrediction, PersonPresence } from "./presence.ts";

const GROUPS = [
  { status: "office", title: "In the office" },
  { status: "remote", title: "Remote" },
  { status: "leave", title: "Away" },
  { status: "unknown", title: "Unknown" },
] as const;

export function describeVisit(visit: OfficeVisit, names: Map<string, string>): string {
  const range = visit.startsOn === visit.endsOn ? visit.startsOn : `${visit.startsOn}..${visit.endsOn}`;
  const people = visit.userIds.map((id) => names.get(id) ?? id);
  const guests = visit.guests > 0 ? [`${visit.guests} guest${visit.guests === 1 ? "" : "s"}`] : [];
  return `[${visit.id}] ${range}: ${visit.note} — ${[...people, ...guests].join(", ")}`;
}

const personLine = (person: PersonPresence) =>
  `- ${person.name ?? person.slackId} (<@${person.slackId}>): ${person.reason}${person.status === "unknown" ? "" : `, ${Math.round(person.confidence * 100)}%`}`;

export function describePrediction(prediction: OfficeDayPrediction): string {
  const names = new Map(prediction.people.map((person) => [person.userId, person.name ?? person.slackId]));
  const sections = GROUPS.flatMap(({ status, title }) => {
    const people = prediction.people.filter((person) => person.status === status);
    return people.length > 0 ? [`${title} (${people.length}):\n${people.map(personLine).join("\n")}`] : [];
  });
  const visits =
    prediction.visits.length > 0 ? [`Visits:\n${prediction.visits.map((visit) => `- ${describeVisit(visit, names)}`).join("\n")}`] : [];
  const guests = prediction.guests > 0 ? ` (incl. ${prediction.guests} guests)` : "";
  return [`${withWeekday(prediction.date)} — expected in the office: ${prediction.expectedInOffice}${guests}`, ...sections, ...visits].join(
    "\n\n",
  );
}
