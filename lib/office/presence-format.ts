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
  const named = visit.guestNames.map((name) => `${name} (guest without a Slack account)`);
  const anonymous = visit.guests - visit.guestNames.length;
  const guests = anonymous > 0 ? [`${anonymous} unnamed guest${anonymous === 1 ? "" : "s"}`] : [];
  const hint =
    anonymous > 0
      ? ` (shown as "Gość 1…" in the desk plan; once you know who they are, name them with update-office-visit: anyone with Slack in people, the rest in guest_names, never clearing someone's own presence or desk instead)`
      : "";
  return `[${visit.id}] ${range}: ${visit.note} — ${[...people, ...named, ...guests].join(", ")}${hint}`;
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
  const guests = prediction.guests > 0 ? ` (incl. guests: ${prediction.guestList.map((guest) => guest.name).join(", ")})` : "";
  return [`${withWeekday(prediction.date)} — expected in the office: ${prediction.expectedInOffice}${guests}`, ...sections, ...visits].join(
    "\n\n",
  );
}
