"use client";

import * as React from "react";
import Link from "next/link";
import {
  ActivityIcon,
  BarChart3Icon,
  BotIcon,
  CalendarClockIcon,
  ClockIcon,
  FolderKanbanIcon,
  GaugeIcon,
  HashIcon,
  HistoryIcon,
  KeyRoundIcon,
  NetworkIcon,
  PalmtreeIcon,
  PlugIcon,
  SquareKanbanIcon,
  UsersIcon,
} from "lucide-react";

import { NavMain, type NavGroup } from "@/components/nav-main";
import { NavUser } from "@/components/nav-user";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar";

const ADMIN_GROUPS: NavGroup[] = [
  {
    label: "Overview",
    items: [
      { title: "Activity", url: "/", icon: <ActivityIcon /> },
      { title: "Dashboard", url: "/dashboard", icon: <GaugeIcon /> },
      { title: "Analytics", url: "/admin/analytics", icon: <BarChart3Icon /> },
    ],
  },
  {
    label: "Memory",
    items: [
      { title: "Graph", url: "/graph", icon: <NetworkIcon /> },
      { title: "Retrospection", url: "/retrospection", icon: <HistoryIcon /> },
    ],
  },
  {
    label: "Access",
    items: [
      { title: "Channels", url: "/admin/access/channels", icon: <HashIcon /> },
      { title: "Projects", url: "/admin/access/projects", icon: <FolderKanbanIcon /> },
      { title: "Members", url: "/admin/access/members", icon: <UsersIcon /> },
      { title: "Vacations", url: "/admin/access/vacations", icon: <PalmtreeIcon /> },
      { title: "Cron skills", url: "/admin/access/cron", icon: <CalendarClockIcon /> },
      { title: "Reminders", url: "/admin/access/reminders", icon: <ClockIcon /> },
      { title: "Linear", url: "/admin/access/linear", icon: <SquareKanbanIcon /> },
      { title: "Secrets", url: "/admin/access/secrets", icon: <KeyRoundIcon /> },
    ],
  },
  {
    label: "Account",
    items: [{ title: "Integrations", url: "/integrations", icon: <PlugIcon /> }],
  },
];

const USER_GROUPS: NavGroup[] = [
  {
    label: "Account",
    items: [{ title: "Integrations", url: "/integrations", icon: <PlugIcon /> }],
  },
];

export function AppSidebar({
  isAdmin,
  user,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  isAdmin: boolean;
  user: { name: string; email: string; image: string | null };
}) {
  return (
    <Sidebar collapsible="offcanvas" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton className="data-[slot=sidebar-menu-button]:p-1.5!" render={<Link href={isAdmin ? "/" : "/integrations"} />}>
              <BotIcon className="size-5!" />
              <span className="text-base font-semibold">Manfrod</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain groups={isAdmin ? ADMIN_GROUPS : USER_GROUPS} />
      </SidebarContent>
      <SidebarFooter>
        <NavUser user={user} />
      </SidebarFooter>
    </Sidebar>
  );
}
