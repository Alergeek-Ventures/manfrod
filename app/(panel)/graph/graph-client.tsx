"use client";

import { NetworkIcon, PanelLeftCloseIcon, PanelLeftOpenIcon, SearchIcon, XIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { matchesQuery, mostFrequent, nodeDegrees, viewStats } from "@/lib/memory/graph-view.ts";
import type { GraphData } from "@/lib/memory/nodes.ts";
import { cn } from "@/lib/utils";
import { deleteNode, loadGraph, saveNode, searchNodes, selectNode, setNodeProject, type Filter, type SelectedNode } from "./actions.ts";
import { GraphCanvas } from "./graph-canvas.tsx";
import { NoteDetail, NoteDetailSkeleton } from "./note-detail.tsx";
import { NoteList, type NoteMeta } from "./note-list.tsx";
import { graphTheme, SERIES_SLOTS, type ColorBy } from "./palette.ts";

type Scope = "private" | "internal" | "external";
type Sort = "recent" | "linked";
type Quick = "orphans" | "weak" | null;

function PlainSelect({
  items,
  value,
  onChange,
  className,
}: {
  items: { label: string; value: string }[];
  value: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <Select items={items} value={value} onValueChange={(next) => next !== null && onChange(next as string)}>
      <SelectTrigger size="sm" className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function Stat({
  value,
  label,
  hint,
  tone,
  active,
  onClick,
}: {
  value: number | string;
  label: string;
  hint: string;
  tone?: "warn" | "bad";
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            disabled={!onClick}
            onClick={onClick}
            className={cn(
              "flex items-baseline gap-1.5 rounded-md px-2 py-1 text-xs transition-colors enabled:hover:bg-muted",
              active && "bg-muted ring-1 ring-border",
            )}
          />
        }
      >
        <span
          className={cn(
            "font-semibold text-sm tabular-nums",
            tone === "bad" && "text-destructive",
            tone === "warn" && "text-amber-600 dark:text-amber-400",
          )}
        >
          {value}
        </span>
        <span className="text-muted-foreground">{label}</span>
      </TooltipTrigger>
      <TooltipContent>{hint}</TooltipContent>
    </Tooltip>
  );
}

export function GraphClient({
  initialGraph,
  soulId,
  currentUserId,
  users,
  projects,
  clients,
}: {
  initialGraph: GraphData;
  soulId: string | null;
  currentUserId: string;
  users: { id: string; label: string }[];
  projects: { id: string; name: string }[];
  clients: string[];
}) {
  const [graph, setGraph] = useState(initialGraph);
  const [filter, setFilter] = useState<Filter>("all");
  const [scope, setScope] = useState<Scope>("internal");
  const [target, setTarget] = useState<string | null>(null);
  const [projectFilter, setProjectFilter] = useState("all");
  const [colorBy, setColorBy] = useState<ColorBy>("project");
  const [sort, setSort] = useState<Sort>("recent");
  const [quick, setQuick] = useState<Quick>(null);
  const [query, setQuery] = useState("");
  const [semantic, setSemantic] = useState<string[]>([]);
  const [listOpen, setListOpen] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SelectedNode | null>(null);
  const [loadingGraph, startGraph] = useTransition();
  const [pending, startTransition] = useTransition();
  const detailRequest = useRef(0);
  const { resolvedTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const theme = useMemo(() => graphTheme(mounted && resolvedTheme === "dark"), [mounted, resolvedTheme]);

  const accessLevel = scope === "private" ? `private/${target}` : scope === "external" ? `external/${target ?? "all"}` : "internal";
  const accessRef = useRef(accessLevel);
  accessRef.current = accessLevel;

  const [slots] = useState(() => ({
    project: mostFrequent(
      initialGraph.nodes.map((node) => node.projectId),
      SERIES_SLOTS,
    ),
    author: mostFrequent(
      initialGraph.nodes.map((node) => node.userId),
      SERIES_SLOTS,
    ),
  }));
  const projectNames = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects]);
  const userNames = useMemo(() => new Map(users.map((user) => [user.id, user.label])), [users]);
  const nodesById = useMemo(() => new Map(graph.nodes.map((node) => [node.id, node])), [graph]);
  const degrees = useMemo(() => nodeDegrees(graph), [graph]);
  const stats = useMemo(() => viewStats(graph, degrees), [graph, degrees]);

  const slotColor = useCallback(
    (key: "project" | "author", value: string | null) => {
      const index = value === null ? -1 : slots[key].indexOf(value);
      return index === -1 ? theme.other : theme.series[index];
    },
    [slots, theme],
  );

  const colorOf = useCallback(
    (id: string) => {
      const node = nodesById.get(id);
      if (!node) return theme.other;
      if (colorBy === "status") return node.processed ? theme.series[0] : theme.series[3];
      if (colorBy === "author") return slotColor("author", node.userId);
      return slotColor("project", node.projectId);
    },
    [nodesById, colorBy, theme, slotColor],
  );

  const legend = useMemo(() => {
    if (colorBy === "status")
      return [
        { label: "Processed", color: theme.series[0] },
        { label: "Slipbox", color: theme.series[3] },
      ];
    const key = colorBy;
    const present = new Set(graph.nodes.map((node) => (key === "project" ? node.projectId : node.userId)));
    const names = key === "project" ? projectNames : userNames;
    const entries = slots[key]
      .filter((id) => present.has(id))
      .map((id) => ({ label: names.get(id) ?? "Unknown", color: slotColor(key, id) }));
    const hasOther = [...present].some((id) => id === null || !slots[key].includes(id));
    if (hasOther) entries.push({ label: key === "project" ? "Other / none" : "Others", color: theme.other });
    return entries;
  }, [colorBy, graph, slots, projectNames, userNames, slotColor, theme]);

  const metas = useMemo(() => {
    const map = new Map<string, NoteMeta>();
    for (const node of graph.nodes) {
      map.set(node.id, {
        color: colorOf(node.id),
        project: node.projectId ? (projectNames.get(node.projectId) ?? null) : null,
        author: userNames.get(node.userId) ?? "Unknown",
        degree: degrees.get(node.id) ?? 0,
      });
    }
    return map;
  }, [graph, colorOf, projectNames, userNames, degrees]);

  const searching = query.trim().length >= 2;

  const visible = useMemo(() => {
    let notes = graph.nodes;
    if (quick === "orphans") notes = notes.filter((node) => node.processed && (degrees.get(node.id) ?? 0) === 0);
    if (quick === "weak") notes = notes.filter((node) => node.processed && (degrees.get(node.id) ?? 0) === 1);
    if (searching) {
      const rank = new Map(semantic.map((id, index) => [id, index]));
      notes = notes.filter((node) => rank.has(node.id) || matchesQuery(node.preview, query));
      return [...notes].sort((a, b) => (rank.get(a.id) ?? Infinity) - (rank.get(b.id) ?? Infinity));
    }
    if (sort === "linked") return [...notes].sort((a, b) => (degrees.get(b.id) ?? 0) - (degrees.get(a.id) ?? 0));
    return notes;
  }, [graph, quick, searching, semantic, query, sort, degrees]);

  const matches = useMemo(() => (searching || quick ? new Set(visible.map((node) => node.id)) : null), [searching, quick, visible]);

  useEffect(() => {
    setSemantic([]);
    const trimmed = query.trim();
    if (trimmed.length < 3) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      searchNodes(accessRef.current, trimmed)
        .then((ids) => !cancelled && setSemantic(ids))
        .catch(() => !cancelled && setSemantic([]));
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  const select = useCallback((id: string | null) => {
    setSelectedId(id);
    const request = ++detailRequest.current;
    if (!id) {
      setDetail(null);
      return;
    }
    selectNode(accessRef.current, id)
      .then((node) => {
        if (request !== detailRequest.current) return;
        if (!node) toast.error("Note not found or not accessible");
        setDetail(node);
        if (!node) setSelectedId(null);
      })
      .catch(() => {
        if (request !== detailRequest.current) return;
        toast.error("Couldn't load the note");
        setSelectedId(null);
      });
  }, []);

  const reload = (nextFilter: Filter, level: string, project: string) =>
    startGraph(async () => {
      const next = await loadGraph(nextFilter, level, project === "all" ? null : project);
      setGraph(next);
      if (selectedId && !next.nodes.some((node) => node.id === selectedId)) select(null);
    });

  const changeAccess = (nextScope: Scope, nextTarget: string | null) => {
    let resolvedScope = nextScope;
    let resolvedTarget = nextTarget;
    if (nextScope === "private") resolvedTarget = nextTarget ?? currentUserId ?? users[0]?.id ?? null;
    if (nextScope === "private" && !resolvedTarget) resolvedScope = "internal";
    if (nextScope === "external") resolvedTarget = nextTarget ?? "all";
    if (resolvedScope === "internal") resolvedTarget = null;
    const level =
      resolvedScope === "private" ? `private/${resolvedTarget}` : resolvedScope === "external" ? `external/${resolvedTarget}` : "internal";
    const project = resolvedScope === "internal" ? projectFilter : "all";
    setScope(resolvedScope);
    setTarget(resolvedTarget);
    setProjectFilter(project);
    setQuery("");
    select(null);
    reload(filter, level, project);
  };

  const notify = (result: { error?: string; info?: string }) => {
    if (result.error) toast.error(result.error);
    else if (result.info) toast.success(result.info);
  };

  const refresh = () => reload(filter, accessLevel, projectFilter);

  const scopeItems = [
    { label: "Private", value: "private" },
    { label: "Internal", value: "internal" },
    { label: "External", value: "external" },
  ];
  const userItems = users.map((user) => ({ label: user.label, value: user.id }));
  const clientItems = [{ label: "All clients", value: "all" }, ...clients.map((client) => ({ label: client, value: client }))];
  const projectItems = [
    { label: "All projects", value: "all" },
    ...projects.map((project) => ({ label: project.name, value: project.id })),
  ];
  const colorItems = [
    { label: "Color by project", value: "project" },
    { label: "Color by author", value: "author" },
    { label: "Color by status", value: "status" },
  ];
  const sortItems = [
    { label: "Newest first", value: "recent" },
    { label: "Most linked", value: "linked" },
  ];

  return (
    <div className="flex h-[calc(100svh-var(--header-height)-1rem)] min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3 lg:px-6">
        <InputGroup className="w-full max-w-xs">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput placeholder="Search memory…" value={query} onChange={(event) => setQuery(event.target.value)} />
          {query !== "" && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton size="icon-xs" onClick={() => setQuery("")}>
                <XIcon />
                <span className="sr-only">Clear search</span>
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
        <ToggleGroup
          variant="outline"
          size="sm"
          value={[filter]}
          onValueChange={(values) => {
            const next = (values[0] as Filter | undefined) ?? filter;
            setFilter(next);
            reload(next, accessLevel, projectFilter);
          }}
        >
          <ToggleGroupItem value="all">All</ToggleGroupItem>
          <ToggleGroupItem value="processed">Processed</ToggleGroupItem>
          <ToggleGroupItem value="slipbox">Slipbox</ToggleGroupItem>
        </ToggleGroup>
        <PlainSelect items={scopeItems} value={scope} onChange={(value) => changeAccess(value as Scope, null)} />
        {scope === "private" && <PlainSelect items={userItems} value={target ?? ""} onChange={(value) => changeAccess("private", value)} />}
        {scope === "external" && (
          <PlainSelect items={clientItems} value={target ?? "all"} onChange={(value) => changeAccess("external", value)} />
        )}
        {scope === "internal" && (
          <PlainSelect
            items={projectItems}
            value={projectFilter}
            onChange={(value) => {
              setProjectFilter(value);
              reload(filter, accessLevel, value);
            }}
          />
        )}
        {loadingGraph && <Spinner />}
        <div className="ml-auto">
          <PlainSelect items={colorItems} value={colorBy} onChange={(value) => setColorBy(value as ColorBy)} />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1 border-b px-3 py-1.5 lg:px-5">
        <Stat value={stats.total_nodes} label="notes" hint="Notes visible with the current filters" />
        <Stat value={stats.total_links} label="links" hint="Links between the visible notes" />
        <Stat value={stats.link_to_note_ratio} label="links / note" hint="A well-connected memory stays around 3 or more" />
        <Stat
          value={stats.slipbox_count}
          label="slipbox"
          tone={stats.slipbox_count > 0 ? "warn" : undefined}
          hint="New notes the retrospector has not processed yet"
        />
        <Stat
          value={stats.orphan_count}
          label="orphans"
          tone={stats.orphan_count > 0 ? "bad" : undefined}
          hint="Processed notes without any link. Click to show them"
          active={quick === "orphans"}
          onClick={() => setQuick(quick === "orphans" ? null : "orphans")}
        />
        <Stat
          value={stats.weakly_connected_count}
          label="weak"
          tone={stats.weakly_connected_count > 0 ? "warn" : undefined}
          hint="Processed notes with a single link. Click to show them"
          active={quick === "weak"}
          onClick={() => setQuick(quick === "weak" ? null : "weak")}
        />
      </div>

      {graph.nodes.length === 0 ? (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <NetworkIcon />
            </EmptyMedia>
            <EmptyTitle>No notes here</EmptyTitle>
            <EmptyDescription>Nothing matches these filters yet. The retrospector fills memory over time.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex min-h-0 flex-1">
          {listOpen && (
            <aside className="hidden w-80 shrink-0 flex-col border-r md:flex xl:w-96">
              <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
                <span className="text-muted-foreground text-xs tabular-nums">
                  {visible.length === graph.nodes.length ? `${visible.length} notes` : `${visible.length} of ${graph.nodes.length} notes`}
                </span>
                <div className="flex items-center gap-1">
                  {!searching && (
                    <PlainSelect items={sortItems} value={sort} onChange={(value) => setSort(value as Sort)} className="h-7 text-xs" />
                  )}
                  <Button size="icon-sm" variant="ghost" onClick={() => setListOpen(false)}>
                    <PanelLeftCloseIcon />
                    <span className="sr-only">Hide list</span>
                  </Button>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                <NoteList notes={visible} metas={metas} selectedId={selectedId} onSelect={select} />
              </div>
            </aside>
          )}

          <div className="relative min-w-0 flex-1">
            <GraphCanvas
              graph={graph}
              degrees={degrees}
              colorOf={colorOf}
              theme={theme}
              selectedId={selectedId}
              matches={matches}
              onSelect={select}
            />

            {!listOpen && (
              <Button size="sm" variant="outline" className="absolute top-3 left-3 hidden md:inline-flex" onClick={() => setListOpen(true)}>
                <PanelLeftOpenIcon data-icon="inline-start" />
                Notes
              </Button>
            )}

            <div className="pointer-events-none absolute bottom-3 left-3 flex max-w-[60%] flex-wrap gap-x-3 gap-y-1 rounded-lg border bg-background/80 px-3 py-2 text-xs shadow-sm backdrop-blur">
              {legend.map((entry) => (
                <span key={entry.label} className="flex items-center gap-1.5">
                  <span className="size-2 rounded-full" style={{ backgroundColor: entry.color }} />
                  {entry.label}
                </span>
              ))}
            </div>

            {selectedId &&
              (detail && detail.id === selectedId ? (
                <NoteDetail
                  key={detail.id}
                  node={detail}
                  author={userNames.get(detail.userId) ?? "Unknown"}
                  isSoul={detail.id === soulId}
                  projects={projects}
                  colorOf={colorOf}
                  pending={pending}
                  onClose={() => select(null)}
                  onOpen={select}
                  onSave={(content) =>
                    new Promise((resolve) =>
                      startTransition(async () => {
                        const result = await saveNode(accessLevel, detail.id, content);
                        notify(result);
                        if (result.node) {
                          setDetail(result.node);
                          refresh();
                        }
                        resolve(Boolean(result.node));
                      }),
                    )
                  }
                  onDelete={() =>
                    startTransition(async () => {
                      const result = await deleteNode(accessLevel, detail.id);
                      notify(result);
                      if (result.info) {
                        select(null);
                        refresh();
                      }
                    })
                  }
                  onProject={(projectId) =>
                    startTransition(async () => {
                      const result = await setNodeProject(accessLevel, detail.id, projectId);
                      notify(result);
                      if (result.node) {
                        setDetail(result.node);
                        refresh();
                      }
                    })
                  }
                />
              ) : (
                <NoteDetailSkeleton onClose={() => select(null)} />
              ))}
          </div>
        </div>
      )}
    </div>
  );
}
