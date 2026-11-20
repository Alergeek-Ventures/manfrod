import type { OfficeVisit } from "../../lib/db/schema.ts";
import { refreshPlans } from "../../lib/office/plan.ts";
import { isLongStay, LONG_STAY_WORKDAYS } from "../../lib/office/plan-rules.ts";
import { loadMembers } from "../../lib/office/presence-sources.ts";
import { addDays, compareDates } from "../../lib/time.ts";

export async function refreshNote(dates: string[]): Promise<string> {
  const updated = await refreshPlans(dates);
  return updated.length > 0 ? `\nUpdated the posted desk plan for ${updated.join(", ")}.` : "";
}

export function datesBetween(from: string, to: string, max = 31): string[] {
  const dates: string[] = [];
  for (let date = from; compareDates(date, to) <= 0 && dates.length < max; date = addDays(date, 1)) dates.push(date);
  return dates;
}

export async function longStayHint(visit: OfficeVisit, names: ReadonlyMap<string, string>): Promise<string> {
  if (!isLongStay(visit)) return "";
  const members = new Set((await loadMembers(visit.layoutId)).map((member) => member.userId));
  const newcomers = visit.userIds.filter((userId) => !members.has(userId)).map((userId) => names.get(userId) ?? userId);
  if (newcomers.length === 0) return "";
  return `\nThis stay spans ${LONG_STAY_WORKDAYS}+ workdays, so it does not trigger visit heads-ups; they count as expected in the office on those days. If ${newcomers.join(", ")} stay for good, suggest that an admin adds them as office members in the office editor.`;
}
