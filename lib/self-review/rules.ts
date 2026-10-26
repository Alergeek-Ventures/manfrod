export const SELF_REVIEW_KIND = "self_review";
export const SELF_REVIEW_SLACK_ID = "system:self-review";
export const MAX_OPEN_PULLS = 2;
export const MIN_RATERS = 2;
export const CATEGORIES = ["prompt", "skill", "routine", "tool"] as const;
export const ACTIVE_STATUSES = ["in_progress", "proposed"] as const;
export const UNRESOLVED_AFTER_HOURS = 12;
export const QUESTION_TTL_DAYS = 5;

export type Category = (typeof CATEGORIES)[number];

export interface Rater {
  slackUserId: string | null;
  admin: boolean;
}

export function hasEnoughEvidence(raters: Rater[]): boolean {
  if (raters.some((rater) => rater.admin)) return true;
  const distinct = new Set(raters.flatMap((rater) => (rater.slackUserId ? [rater.slackUserId] : [])));
  return distinct.size >= MIN_RATERS;
}

export function freeSlots(active: number): number {
  return Math.max(MAX_OPEN_PULLS - active, 0);
}
