import { listJoin } from "../names.ts";
import { addDays, compareDates } from "../time.ts";

export const HEADS_UP_MIN_WORKDAYS = 2;
export const HEADS_UP_MAX_WORKDAYS = 5;

export const VISIT_MIN_EXTRA_PEOPLE = 2;
export const LONG_STAY_WORKDAYS = 5;

export type Crowding = {
  crowded: boolean;
  crowdedWithoutVisits: boolean;
  reasons: string[];
  visitReasons: string[];
  deskReasons: string[];
};

export type CrowdingInput = {
  visitSummaries: string[];
  visitExtraPeople: number;
  demand: number;
  supply: number;
  expectedInOffice: number;
  threshold: number;
};

export function peopleCount(count: number): string {
  if (count === 1) return "1 osoba";
  const tens = count % 100;
  const ones = count % 10;
  if (ones >= 2 && ones <= 4 && (tens < 12 || tens > 14)) return `${count} osoby`;
  return `${count} osób`;
}

export function guestCount(count: number): string {
  return count === 1 ? "1 gość" : `${count} gości`;
}

export function visitSummary(names: string[], anonymous: number, place: string | null): string {
  const unnamed = anonymous > 0 ? [`${peopleCount(anonymous)}${place ? ` z ${place}` : ""}`] : [];
  return listJoin([...names, ...unnamed]);
}

export function crowding(input: CrowdingInput): Crowding {
  const visitReasons =
    input.visitExtraPeople >= VISIT_MIN_EXTRA_PEOPLE ? input.visitSummaries.map((summary) => `przyjeżdża: ${summary}`) : [];
  const deskReasons =
    input.demand > input.supply
      ? [`${peopleCount(input.demand)} bez własnego biurka, a wolnych biurek bez właściciela jest ${input.supply}`]
      : [];
  const otherReasons = [
    ...deskReasons,
    ...(input.expectedInOffice >= input.threshold ? [`~${peopleCount(input.expectedInOffice)} w biurze (próg: ${input.threshold})`] : []),
  ];
  const reasons = [...visitReasons, ...otherReasons];
  return { crowded: reasons.length > 0, crowdedWithoutVisits: otherReasons.length > 0, reasons, visitReasons, deskReasons };
}

const weekday = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

export const isWorkday = (date: string, holidays: ReadonlySet<string>) => weekday(date) !== 0 && weekday(date) !== 6 && !holidays.has(date);

export function workdaysAfter(today: string, count: number, holidays: ReadonlySet<string>): string[] {
  const days: string[] = [];
  for (let date = addDays(today, 1); days.length < count; date = addDays(date, 1)) if (isWorkday(date, holidays)) days.push(date);
  return days;
}

export const nextWorkday = (today: string, holidays: ReadonlySet<string>) => workdaysAfter(today, 1, holidays)[0];

export function workdayCount(from: string, to: string): number {
  let count = 0;
  for (let date = from; compareDates(date, to) <= 0; date = addDays(date, 1)) if (isWorkday(date, new Set())) count += 1;
  return count;
}

export const isLongStay = (visit: { startsOn: string; endsOn: string }) => workdayCount(visit.startsOn, visit.endsOn) >= LONG_STAY_WORKDAYS;

export type VisitRange = { id: string; startsOn: string; endsOn: string };

export type HeadsUpGroup = { dates: string[]; visitIds: string[] };

export function headsUpGroups(
  today: string,
  visits: VisitRange[],
  plannedDates: ReadonlySet<string>,
  holidays: ReadonlySet<string>,
): HeadsUpGroup[] {
  const window = workdaysAfter(today, HEADS_UP_MAX_WORKDAYS, holidays).slice(HEADS_UP_MIN_WORKDAYS - 1);
  const taken = new Set(plannedDates);
  const groups: HeadsUpGroup[] = [];
  for (const visit of [...visits].filter((visit) => !isLongStay(visit)).sort((a, b) => compareDates(a.startsOn, b.startsOn))) {
    const covered = window.filter((date) => compareDates(visit.startsOn, date) <= 0 && compareDates(visit.endsOn, date) >= 0);
    if (covered.some((date) => plannedDates.has(date))) continue;
    const dates = covered.filter((date) => !taken.has(date));
    const joined = groups.find((group) => group.dates.some((date) => covered.includes(date)));
    if (joined) {
      if (!joined.visitIds.includes(visit.id)) joined.visitIds.push(visit.id);
      joined.dates = [...new Set([...joined.dates, ...dates])].sort();
    } else if (dates.length > 0) groups.push({ dates, visitIds: [visit.id] });
    for (const date of dates) taken.add(date);
  }
  return groups;
}

export type CronAction = "post" | "refresh" | "skip";

export function planCronAction(status: string | null, crowding: Pick<Crowding, "crowded" | "crowdedWithoutVisits">): CronAction {
  switch (status) {
    case "posted":
      return "refresh";
    case "posting":
      return "skip";
    case "requested":
      return "post";
    case "declined":
      return crowding.crowdedWithoutVisits ? "post" : "skip";
    default:
      return crowding.crowded ? "post" : "skip";
  }
}

const ON_DAY = ["w niedzielę", "w poniedziałek", "we wtorek", "w środę", "w czwartek", "w piątek", "w sobotę"];

const shortDate = (date: string) => `${Number(date.slice(8, 10))}.${date.slice(5, 7)}`;

export const dayLabel = (date: string) => `${ON_DAY[weekday(date)]} ${shortDate(date)}`;

export function daysLabel(dates: string[]): string {
  if (dates.length <= 1) return dayLabel(dates[0]);
  return `${dayLabel(dates[0])} – ${dayLabel(dates.at(-1)!).replace(/^we? /, "")}`;
}

export const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function headsUpText(dates: string[], expected: number, visitSummaries: string[]): string {
  const visits = visitSummaries.length > 0 ? ` (przyjeżdża: ${visitSummaries.join("; ")})` : "";
  return `${capitalize(daysLabel(dates))} ~${peopleCount(expected)}${visits}. Przygotować plan biurek?`;
}

export function planHeadline(date: string, seated: number, guests: number): string {
  const including = guests > 0 ? ` (w tym ${guestCount(guests)})` : "";
  return `*${capitalize(dayLabel(date))}: ${peopleCount(seated)} w biurze${including}.*`;
}

export type ReasonInput = {
  requestedBy: string | null;
  crowded: boolean;
  visitReasons: string[];
  deskReasons: string[];
  seated: number;
  threshold: number;
};

export function planReasonLine(input: ReasonInput): string {
  const reasons = [
    ...input.visitReasons,
    ...input.deskReasons,
    ...(input.seated >= input.threshold ? [`próg tłoku to ${peopleCount(input.threshold)}`] : []),
  ];
  if (input.requestedBy && (!input.crowded || reasons.length === 0)) return `Plan na prośbę <@${input.requestedBy}>.`;
  return reasons.length > 0 ? `${capitalize(reasons.join("; "))}.` : "";
}

export function longStayNote(names: string[], endsOn: string): string {
  const one = names.length === 1;
  return `${listJoin(names)} ${one ? "jest" : "są"} w biurze do ${shortDate(endsOn)}. Jeśli to na dłużej, admin może dodać ${one ? "tę osobę" : "te osoby"} do osób biura w edytorze biura.`;
}

export const planTitle = (date: string) => `Plan biurek — ${ON_DAY[weekday(date)].replace(/^we? /, "")} ${shortDate(date)}`;
