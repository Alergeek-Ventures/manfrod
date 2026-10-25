import { redirect } from "next/navigation";
import { TABS, type Tab } from "./tabs.ts";

export default async function AccessPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  redirect(`/admin/access/${TABS.includes(tab as Tab) ? tab : "channels"}`);
}
