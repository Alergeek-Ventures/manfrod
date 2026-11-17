import { recordedAwayUserIds } from "./away.ts";
import { getLayout } from "./layout.ts";
import { planAwayUserIds } from "./plan-store.ts";
import { predictOfficeDay } from "./presence.ts";

export const PREDICTED_LEAVE_CONFIDENCE = 0.9;

export async function awayUserIdsFor(date: string): Promise<Set<string>> {
  const layout = await getLayout();
  const fromPlan = await planAwayUserIds(layout.id, date);
  if (fromPlan) return fromPlan;
  const [recorded, prediction] = await Promise.all([recordedAwayUserIds(date), predictOfficeDay(date, { layoutId: layout.id })]);
  for (const person of prediction.people)
    if (person.status === "leave" && person.confidence >= PREDICTED_LEAVE_CONFIDENCE) recorded.add(person.userId);
  return recorded;
}
