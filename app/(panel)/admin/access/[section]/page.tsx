import { notFound } from "next/navigation";
import { loadAccessData } from "@/lib/web/access-data.ts";
import { requireAdmin } from "@/lib/web/session.ts";
import { AccessClient } from "../access-client.tsx";
import { TABS, type Tab } from "../tabs.ts";

export const dynamic = "force-dynamic";

export default async function AccessSectionPage({ params }: { params: Promise<{ section: string }> }) {
  await requireAdmin();
  const { section } = await params;
  if (!TABS.includes(section as Tab)) notFound();
  return <AccessClient tab={section as Tab} data={await loadAccessData()} />;
}
