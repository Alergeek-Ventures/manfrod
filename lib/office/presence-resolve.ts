import { addDays, compareDates } from "../time.ts";

export type PresenceStatus = "office" | "remote" | "leave" | "unknown";
export type StatedStatus = Exclude<PresenceStatus, "unknown">;

export interface SessionDay {
  date: string;
  remote: boolean;
}

export interface LeaveRequest {
  startsOn: string;
  endsOn: string;
  status: string | null;
  category: string | null;
  reason: string | null;
}

export interface PresenceSignals {
  date: string;
  today: string;
  explicit?: { status: StatedStatus; source: string; note: string | null } | null;
  leaveRequests?: LeaveRequest[];
  absences?: string[];
  visit?: { note: string } | null;
  sessionDays?: SessionDay[];
  reservedThatDay?: boolean;
  reservationDates?: string[];
}

export interface PresenceResolution {
  status: PresenceStatus;
  confidence: number;
  sources: string[];
  reason: string;
}

export const HABIT_WEEKS = 8;
export const HABIT_MIN_DAYS = 3;
export const HABIT_OFFICE_SHARE = 0.7;
export const HABIT_REMOTE_SHARE = 0.3;
export const HABIT_MAX_CONFIDENCE = 0.8;
export const RESERVATION_HABIT_MIN_WEEKS = 3;
export const RESERVATION_HABIT_MAX_CONFIDENCE = 0.7;

const CONFIDENCE = {
  explicit: 1,
  approvedLeave: 0.95,
  pendingLeave: 0.8,
  absence: 0.9,
  visit: 0.9,
  session: 0.9,
  reservation: 0.8,
};

const DROPPED_LEAVE = /reject|declin|cancel|withdraw|odrzu|anulo|wycof/i;
const APPROVED_LEAVE = /approv|accept|zaakcept|zatwierdz/i;
const WORKING_AWAY = /pracuje poza biurem/i;
const REMOTE_CATEGORY = /remote|zdaln/i;

const WEEKDAYS_PLURAL = ["w niedziele", "w poniedziałki", "we wtorki", "w środy", "w czwartki", "w piątki", "w soboty"];

const STATED_REASON: Record<StatedStatus, string> = {
  office: "zapowiedział(a), że będzie w biurze",
  remote: "zapowiedział(a) pracę zdalną",
  leave: "zapowiedział(a) nieobecność",
};

export function weekdayOf(dateIso: string): number {
  const [year, month, day] = dateIso.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export const habitWindowStart = (date: string, today: string) => addDays(compareDates(date, today) < 0 ? date : today, -HABIT_WEEKS * 7);

export function isActiveLeave(request: LeaveRequest): boolean {
  return !DROPPED_LEAVE.test(request.status ?? "");
}

const round = (value: number) => Math.round(value * 100) / 100;

function result(status: PresenceStatus, confidence: number, source: string, reason: string): PresenceResolution {
  return { status, confidence: round(confidence), sources: [source], reason };
}

function fromLeave(date: string, requests: LeaveRequest[]): PresenceResolution | null {
  const covering = requests.filter((request) => request.startsOn <= date && request.endsOn >= date && isActiveLeave(request));
  if (covering.length === 0) return null;
  const request = covering.find((candidate) => APPROVED_LEAVE.test(candidate.status ?? "")) ?? covering[0];
  const approved = APPROVED_LEAVE.test(request.status ?? "");
  const confidence = approved ? CONFIDENCE.approvedLeave : CONFIDENCE.pendingLeave;
  if (REMOTE_CATEGORY.test(`${request.category ?? ""} ${request.reason ?? ""}`))
    return result("remote", confidence, "firmowid_leave", "praca zdalna zgłoszona w Firmowidzie");
  return result("leave", confidence, "firmowid_leave", approved ? "urlop w Firmowidzie" : "wniosek urlopowy w Firmowidzie");
}

function fromAbsence(absences: string[]): PresenceResolution | null {
  if (absences.length === 0) return null;
  if (absences.every((absence) => WORKING_AWAY.test(absence)))
    return result("remote", CONFIDENCE.absence, "absence", "pracuje poza biurem (zapisana nieobecność)");
  return result("leave", CONFIDENCE.absence, "absence", "zapisana nieobecność");
}

function fromSession(date: string, today: string, days: SessionDay[]): PresenceResolution | null {
  if (compareDates(date, today) > 0) return null;
  const day = days.find((candidate) => candidate.date === date);
  if (!day) return null;
  return day.remote
    ? result("remote", CONFIDENCE.session, "firmowid_session", "sesja zdalna w Firmowidzie")
    : result("office", CONFIDENCE.session, "firmowid_session", "sesja z biura w Firmowidzie");
}

export function sessionHabit(date: string, today: string, days: SessionDay[]): PresenceResolution | null {
  const from = habitWindowStart(date, today);
  const weekday = weekdayOf(date);
  const sample = days.filter(
    (day) => day.date >= from && compareDates(day.date, date) < 0 && compareDates(day.date, today) < 0 && weekdayOf(day.date) === weekday,
  );
  if (sample.length < HABIT_MIN_DAYS) return null;
  const office = sample.filter((day) => !day.remote).length;
  const share = office / sample.length;
  const label = WEEKDAYS_PLURAL[weekday];
  if (share >= HABIT_OFFICE_SHARE)
    return result("office", share * HABIT_MAX_CONFIDENCE, "firmowid_habit", `zwykle w biurze ${label} (${office}/${sample.length})`);
  if (share <= HABIT_REMOTE_SHARE)
    return result(
      "remote",
      (1 - share) * HABIT_MAX_CONFIDENCE,
      "firmowid_habit",
      `zwykle zdalnie ${label} (${sample.length - office}/${sample.length})`,
    );
  return null;
}

export function reservationHabit(date: string, today: string, dates: string[]): PresenceResolution | null {
  const from = habitWindowStart(date, today);
  const weekday = weekdayOf(date);
  const matching = new Set(dates.filter((day) => day >= from && compareDates(day, date) < 0 && weekdayOf(day) === weekday));
  if (matching.size < RESERVATION_HABIT_MIN_WEEKS) return null;
  const share = Math.min(1, matching.size / HABIT_WEEKS);
  return result(
    "office",
    share * RESERVATION_HABIT_MAX_CONFIDENCE,
    "reservation_habit",
    `zwykle rezerwuje biurko ${WEEKDAYS_PLURAL[weekday]} (${matching.size}/${HABIT_WEEKS})`,
  );
}

export function resolvePresence(signals: PresenceSignals): PresenceResolution {
  const { date, today } = signals;
  if (signals.explicit) {
    const note = signals.explicit.note ? `: ${signals.explicit.note}` : "";
    return result(
      signals.explicit.status,
      CONFIDENCE.explicit,
      `explicit_${signals.explicit.source}`,
      `${STATED_REASON[signals.explicit.status]}${note}`,
    );
  }
  return (
    fromLeave(date, signals.leaveRequests ?? []) ??
    fromAbsence(signals.absences ?? []) ??
    (signals.visit ? result("office", CONFIDENCE.visit, "visit", `wizyta: ${signals.visit.note}`) : null) ??
    fromSession(date, today, signals.sessionDays ?? []) ??
    (signals.reservedThatDay ? result("office", CONFIDENCE.reservation, "reservation", "zarezerwowane biurko") : null) ??
    sessionHabit(date, today, signals.sessionDays ?? []) ??
    reservationHabit(date, today, signals.reservationDates ?? []) ??
    result("unknown", 0, "none", "brak danych")
  );
}
