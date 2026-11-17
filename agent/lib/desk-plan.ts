import { refreshPlans } from "../../lib/office/plan.ts";
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
