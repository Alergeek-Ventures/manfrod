import { isConfirmedAway, recordedAwayUserIds } from "./away.ts";
import { getLayout } from "./layout.ts";
import { planAwayUserIds } from "./plan-store.ts";
import { predictOfficeDay } from "./presence.ts";

export async function awayUserIdsFor(date: string): Promise<Set<string>> {
  const layout = await getLayout();
  const fromPlan = await planAwayUserIds(layout.id, date);
  if (fromPlan) return fromPlan;
  const [recorded, prediction] = await Promise.all([recordedAwayUserIds(date), predictOfficeDay(date, { layoutId: layout.id })]);
  for (const person of prediction.people) if (isConfirmedAway(person)) recorded.add(person.userId);
  return recorded;
}
