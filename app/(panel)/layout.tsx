import { AppSidebar } from "@/components/app-sidebar";
import { SiteHeader } from "@/components/site-header";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { isAdminEmail } from "@/lib/config.ts";
import { requireUser } from "@/lib/web/session.ts";

export default async function PanelLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  return (
    <SidebarProvider
      style={{ "--sidebar-width": "calc(var(--spacing) * 64)", "--header-height": "calc(var(--spacing) * 12)" } as React.CSSProperties}
    >
      <AppSidebar variant="inset" isAdmin={isAdminEmail(user.email)} user={{ name: user.name ?? user.slackId, email: user.email ?? "" }} />
      <SidebarInset>
        <SiteHeader />
        <div className="@container/main flex flex-1 flex-col">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}
