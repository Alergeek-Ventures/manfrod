export const TABS = ["agent", "channels", "projects", "members", "vacations", "cron", "reminders", "linear", "github"] as const;
export type Tab = (typeof TABS)[number];
