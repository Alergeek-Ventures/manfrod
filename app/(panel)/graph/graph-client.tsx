"use client";

import type { Core, ElementDefinition } from "cytoscape";
import { useEffect, useRef, useState, useTransition } from "react";
import { NetworkIcon, PencilIcon, SearchIcon, XIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { ConfirmAction } from "@/components/confirm-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import type { GraphData, GraphStats } from "@/lib/memory/nodes.ts";
import { deleteNode, loadGraph, saveNode, searchNodes, selectNode, setNodeProject, type Filter, type SelectedNode } from "./actions.ts";

type Scope = "private" | "internal" | "external";

const NONE = "__none__";

function cssColor(variable: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(variable).trim();
  if (!value) return fallback;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d");
  if (!context) return fallback;
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}

function themePalette() {
  return {
    text: cssColor("--muted-foreground", "#a1a1aa"),
    processed: cssColor("--chart-2", "#2dd4bf"),
    slipbox: cssColor("--chart-4", "#fbbf24"),
    selected: cssColor("--primary", "#3b82f6"),
    highlighted: cssColor("--chart-1", "#f472b6"),
    edge: cssColor("--border", "#52525b"),
  };
}

function PlainSelect({ items, value, onChange }: { items: { label: string; value: string }[]; value: string; onChange: (value: string) => void }) {
  return (
    <Select items={items} value={value} onValueChange={(next) => next !== null && onChange(next as string)}>
      <SelectTrigger size="sm">
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

function elements(graph: GraphData): ElementDefinition[] {
  return [
    ...graph.nodes.map((node) => ({
      data: {
        id: node.id,
        label: node.content_preview,
        content: node.content,
        processed: node.processed,
        link_count: node.link_count,
        inserted_at: node.inserted_at,
      },
    })),
    ...graph.edges.map((edge) => ({ data: { id: `${edge.source}-${edge.target}`, source: edge.source, target: edge.target } })),
  ];
}

const LAYOUT = { name: "cose", nodeRepulsion: 8000, idealEdgeLength: 100, gravity: 0.25 } as const;

const formatDate = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;

export function GraphClient({
  initialGraph,
  initialStats,
  soulId,
  currentUserId,
  users,
  projects,
  clients,
}: {
  initialGraph: GraphData;
  initialStats: GraphStats;
  soulId: string | null;
  currentUserId: string;
  users: { id: string; label: string }[];
  projects: { id: string; name: string }[];
  clients: string[];
}) {
  const container = useRef<HTMLDivElement>(null);
  const cy = useRef<Core | null>(null);
  const [graph, setGraph] = useState(initialGraph);
  const [stats, setStats] = useState(initialStats);
  const [filter, setFilter] = useState<Filter>("all");
  const [scope, setScope] = useState<Scope>("internal");
  const [target, setTarget] = useState<string | null>(null);
  const [projectFilter, setProjectFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [node, setNode] = useState<SelectedNode | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [pending, startTransition] = useTransition();
  const { resolvedTheme } = useTheme();
  const notify = (result: { error?: string; info?: string }) => {
    if (result.error) toast.error(result.error);
    else if (result.info) toast.success(result.info);
  };

  const accessLevel = scope === "private" ? `private/${target}` : scope === "external" ? `external/${target ?? "all"}` : "internal";
  const accessRef = useRef(accessLevel);
  accessRef.current = accessLevel;

  useEffect(() => {
    if (!container.current || graph.nodes.length === 0) return;
    let disposed = false;
    void import("cytoscape").then(({ default: cytoscape }) => {
      if (disposed || !container.current) return;
      const palette = themePalette();
      const instance = cytoscape({
        container: container.current,
        elements: elements(graph),
        style: [
          {
            selector: "node",
            style: {
              label: "data(label)",
              "text-wrap": "ellipsis",
              "text-max-width": "100px",
              "font-size": "10px",
              color: palette.text,
              "text-valign": "bottom",
              "text-margin-y": 5,
              "background-color": palette.processed,
              width: "mapData(link_count, 0, 20, 20, 50)",
              height: "mapData(link_count, 0, 20, 20, 50)",
            },
          },
          { selector: "node[!processed]", style: { "background-color": palette.slipbox } },
          { selector: "node:selected", style: { "border-color": palette.selected, "border-width": 3 } },
          { selector: "node.highlighted", style: { "border-color": palette.highlighted, "border-width": 3 } },
          { selector: "edge", style: { "line-color": palette.edge, width: 1, "curve-style": "bezier" } },
        ],
        layout: { ...LAYOUT, animate: false },
        minZoom: 0.1,
        maxZoom: 3,
      });
      if (soulId) {
        const soul = instance.getElementById(soulId);
        if (soul.length > 0) {
          instance.center(soul);
          soul.select();
        }
      }
      instance.on("tap", "node", (event) => {
        const id = event.target.id();
        startTransition(async () => {
          const selectedNode = await selectNode(accessRef.current, id);
          setNode(selectedNode);
          setEditing(false);
          setDraft(selectedNode?.content ?? "");
        });
      });
      instance.on("tap", (event) => {
        if (event.target === instance) {
          setNode(null);
          setEditing(false);
        }
      });
      cy.current = instance;
    });
    return () => {
      disposed = true;
      cy.current?.destroy();
      cy.current = null;
    };
  }, [graph.nodes.length === 0, resolvedTheme]);

  useEffect(() => {
    const instance = cy.current;
    if (!instance) return;
    instance.json({ elements: elements(graph) });
    instance.layout({ ...LAYOUT, animate: true, animationDuration: 500 }).run();
  }, [graph]);

  const highlight = (ids: string[], centerOn: string | null) => {
    const instance = cy.current;
    if (!instance) return;
    instance.nodes().removeClass("highlighted");
    for (const id of ids) instance.getElementById(id).addClass("highlighted");
    if (centerOn) {
      const center = instance.getElementById(centerOn);
      if (center.length > 0) {
        instance.animate({ center: { eles: center }, zoom: 1.5, duration: 300 });
        center.select();
      }
    }
  };

  const reload = (nextFilter: Filter, level: string, project: string) =>
    startTransition(async () => {
      const result = await loadGraph(nextFilter, level, project === "all" ? null : project);
      setGraph(result.graph);
      setStats(result.stats);
    });

  useEffect(() => {
    if (query.length < 3) {
      cy.current?.nodes().removeClass("highlighted");
      return;
    }
    const timer = setTimeout(() => {
      startTransition(async () => {
        const ids = await searchNodes(accessRef.current, query);
        if (ids.length === 0) cy.current?.nodes().removeClass("highlighted");
        else highlight(ids, ids[0]);
      });
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

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
    reload(filter, level, project);
  };

  const refreshAfterMutation = () => reload(filter, accessLevel, projectFilter);

  const scopeItems = [
    { label: "Private", value: "private" },
    { label: "Internal", value: "internal" },
    { label: "External", value: "external" },
  ];
  const userItems = users.map((user) => ({ label: user.label, value: user.id }));
  const clientItems = [{ label: "All clients", value: "all" }, ...clients.map((client) => ({ label: client, value: client }))];
  const projectItems = [{ label: "All projects", value: "all" }, ...projects.map((project) => ({ label: project.name, value: project.id }))];
  const nodeProjectItems = [{ label: "No project", value: NONE }, ...projects.map((project) => ({ label: project.name, value: project.id }))];

  return (
    <div className="flex h-[calc(100svh-var(--header-height)-1rem)] min-h-0 flex-col">
      <div className="flex flex-col gap-3 border-b p-4 lg:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <InputGroup className="w-full max-w-sm">
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput placeholder="Search nodes…" value={query} onChange={(event) => setQuery(event.target.value)} />
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
          {scope === "external" && <PlainSelect items={clientItems} value={target ?? "all"} onChange={(value) => changeAccess("external", value)} />}
          {scope === "internal" && (
            <PlainSelect
              items={projectItems}
              value={projectFilter}
              onChange={(value) => {
                setProjectFilter(value);
                setQuery("");
                reload(filter, accessLevel, value);
              }}
            />
          )}
          {pending && <Spinner />}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{stats.total_nodes} nodes</Badge>
          <Badge variant="outline">{stats.total_links} links</Badge>
          <Badge variant={stats.slipbox_count > 0 ? "secondary" : "outline"}>{stats.slipbox_count} slipbox</Badge>
          <Badge variant={stats.orphan_count > 0 ? "destructive" : "outline"}>{stats.orphan_count} orphans</Badge>
          <Badge variant={stats.weakly_connected_count > 0 ? "secondary" : "outline"}>{stats.weakly_connected_count} weak</Badge>
          <Badge variant={stats.link_to_note_ratio >= 3 ? "default" : "outline"}>ratio {stats.link_to_note_ratio}</Badge>
        </div>
      </div>

      {graph.nodes.length === 0 ? (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <NetworkIcon />
            </EmptyMedia>
            <EmptyTitle>No notes yet</EmptyTitle>
            <EmptyDescription>The retrospector will populate the graph over time.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div ref={container} className="min-h-0 flex-1" />
      )}

      <Sheet
        open={node !== null}
        onOpenChange={(open) => {
          if (!open) {
            setNode(null);
            setEditing(false);
          }
        }}
      >
        <SheetContent className="w-full overflow-y-auto sm:max-w-md">
          {node && (
            <>
              <SheetHeader>
                <SheetTitle>Note</SheetTitle>
                <SheetDescription className="break-all font-mono">{node.id}</SheetDescription>
                <div className="flex gap-2">
                  <Badge variant={node.processed ? "default" : "secondary"}>{node.processed ? "processed" : "slipbox"}</Badge>
                  <Badge variant="outline">{node.linkCount} links</Badge>
                  <Badge variant="outline">{formatDate(node.insertedAt)}</Badge>
                </div>
              </SheetHeader>
              <FieldGroup className="px-4">
                <Field>
                  <FieldLabel>Project</FieldLabel>
                  <PlainSelect
                    items={nodeProjectItems}
                    value={node.projectId ?? NONE}
                    onChange={(value) =>
                      startTransition(async () => {
                        const result = await setNodeProject(accessLevel, node.id, value === NONE ? null : value);
                        notify(result);
                        if (result.node) setNode(result.node);
                      })
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="node-content">Content</FieldLabel>
                  {editing ? (
                    <Textarea id="node-content" className="min-h-40" value={draft} onChange={(event) => setDraft(event.target.value)} />
                  ) : (
                    <p className="max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted p-3 text-sm">{node.content}</p>
                  )}
                </Field>
                <div className="flex gap-2">
                  {editing ? (
                    <>
                      <Button
                        size="sm"
                        onClick={() =>
                          startTransition(async () => {
                            const result = await saveNode(accessLevel, node.id, draft);
                            notify(result);
                            if (result.node) {
                              setNode(result.node);
                              setEditing(false);
                              refreshAfterMutation();
                            }
                          })
                        }
                      >
                        Save
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEditing(false);
                          setDraft(node.content);
                        }}
                      >
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                        <PencilIcon data-icon="inline-start" />
                        Edit
                      </Button>
                      <ConfirmAction
                        label="Delete"
                        variant="outline"
                        title="Delete this note?"
                        description="The note and all its links are removed from memory."
                        confirmLabel="Delete"
                        onConfirm={() =>
                          startTransition(async () => {
                            const result = await deleteNode(accessLevel, node.id);
                            notify(result);
                            if (result.info) {
                              setNode(null);
                              refreshAfterMutation();
                            }
                          })
                        }
                      />
                    </>
                  )}
                </div>
                {node.links.length > 0 && (
                  <Field>
                    <FieldLabel>Linked notes</FieldLabel>
                    <div className="flex flex-col gap-1">
                      {node.links.map((link) => (
                        <Button
                          key={link.id}
                          variant="ghost"
                          size="sm"
                          className="justify-start font-normal"
                          onClick={() =>
                            startTransition(async () => {
                              const next = await selectNode(accessLevel, link.id);
                              setNode(next);
                              setEditing(false);
                              setDraft(next?.content ?? "");
                              highlight([link.id], link.id);
                            })
                          }
                        >
                          <span className="truncate">{link.preview}…</span>
                        </Button>
                      ))}
                    </div>
                  </Field>
                )}
              </FieldGroup>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
