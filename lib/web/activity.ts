import type { Activity } from "../events/index.ts";

export function serializeActivity(activity: Activity) {
  return { ...activity, timestamp: activity.timestamp.toISOString() };
}
