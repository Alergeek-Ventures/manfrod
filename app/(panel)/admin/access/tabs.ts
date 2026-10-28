export const TABS = ["agent", "channels", "projects", "members", "vacations", "cron", "reminders", "linear"] as const;
export type Tab = (typeof TABS)[number];
