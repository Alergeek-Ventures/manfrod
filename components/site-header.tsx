"use client"

import { usePathname } from "next/navigation"
import { MoonIcon, SunIcon } from "lucide-react"
import { useTheme } from "next-themes"

import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"

const TITLES: Record<string, string> = {
  "/": "Activity",
  "/dashboard": "Dashboard",
  "/admin/analytics": "Analytics",
  "/graph": "Memory graph",
  "/retrospection": "Retrospection",
  "/integrations": "Integrations",
  "/chat": "Chat",
}

const ACCESS_TABS: Record<string, string> = {
  channels: "Channels",
  projects: "Projects",
  members: "Members",
  vacations: "Vacations",
  cron: "Cron skills",
  reminders: "Reminders",
  linear: "Linear",
  secrets: "Secrets",
}

function Title() {
  const pathname = usePathname()
  const section = pathname.startsWith("/admin/access/") ? pathname.slice("/admin/access/".length) : null
  const title = section ? (ACCESS_TABS[section] ?? "Access") : (TITLES[pathname] ?? "Manfrod")
  return <h1 className="text-base font-medium">{title}</h1>
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()
  return (
    <Button
      variant="ghost"
      size="icon"
      className="ml-auto"
      onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
    >
      <SunIcon className="hidden dark:block" />
      <MoonIcon className="dark:hidden" />
      <span className="sr-only">Toggle theme</span>
    </Button>
  )
}

export function SiteHeader() {
  return (
    <header className="flex h-(--header-height) shrink-0 items-center gap-2 border-b transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-(--header-height)">
      <div className="flex w-full items-center gap-1 px-4 lg:gap-2 lg:px-6">
        <SidebarTrigger className="-ml-1" />
        <Separator orientation="vertical" className="mx-2 h-4 data-vertical:self-auto" />
        <Title />
        <ThemeToggle />
      </div>
    </header>
  )
}
