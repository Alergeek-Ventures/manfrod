import { notFound } from "next/navigation";
import { loadAccessData } from "@/lib/web/access-data.ts";
import { requireAdmin } from "@/lib/web/session.ts";
import { AccessClient } from "../access-client.tsx";
import { TABS, type Tab } from "../tabs.ts";

export const dynamic = "force-dynamic";

export default async function AccessSectionPage({
  params,
  searchParams,
}: {
  params: Promise<{ section: string }>;
  searchParams: Promise<{ error?: string; info?: string }>;
}) {
  const admin = await requireAdmin();
  const { section } = await params;
  if (!TABS.includes(section as Tab)) notFound();
  const { error, info } = await searchParams;
  return <AccessClient tab={section as Tab} data={await loadAccessData()} flash={{ error, info }} currentUserId={admin.id} />;
}
