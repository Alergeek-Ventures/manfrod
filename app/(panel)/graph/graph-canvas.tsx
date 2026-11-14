"use client";

import type Graph from "graphology";
import type FA2Layout from "graphology-layout-forceatlas2/worker";
import { LocateFixedIcon, MinusIcon, PlusIcon, SparklesIcon } from "lucide-react";
import type Sigma from "sigma";
import type { NodeHoverDrawingFunction } from "sigma/rendering";
import type { Settings } from "sigma/settings";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { GraphData } from "@/lib/memory/nodes.ts";
import type { GraphTheme } from "./palette.ts";

const POSITIONS_KEY = "manfrod.graph.positions";
const LABEL_LENGTH = 34;
const DETAIL_PANEL_WIDTH = 412;

type Positions = Record<string, [number, number]>;

const isPosition = (value: unknown): value is [number, number] =>
  Array.isArray(value) && value.length === 2 && value.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate));

function loadPositions(): Positions {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(POSITIONS_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => isPosition(value))) as Positions;
  } catch {
    return {};
  }
}

function savePositions(graph: Graph) {
  const positions = loadPositions();
  graph.forEachNode((id, attributes) => {
    positions[id] = [Math.round(attributes.x * 100) / 100, Math.round(attributes.y * 100) / 100];
  });
  try {
    localStorage.setItem(POSITIONS_KEY, JSON.stringify(positions));
  } catch {}
}

const shortLabel = (text: string) => {
  const line = text.replace(/\s+/g, " ").trim();
  const characters = Array.from(line);
  return characters.length > LABEL_LENGTH ? `${characters.slice(0, LABEL_LENGTH).join("").trimEnd()}…` : line;
};

const nodeSize = (degree: number) => 2 + Math.sqrt(degree) * 1.6;

function hoverDrawer(theme: GraphTheme): NodeHoverDrawingFunction {
  return (context, data, settings) => {
    context.beginPath();
    context.arc(data.x, data.y, data.size + 3, 0, Math.PI * 2);
    context.strokeStyle = theme.edgeFocus;
    context.lineWidth = 2;
    context.stroke();
    if (!data.label) return;
    const size = settings.labelSize;
    context.font = `500 ${size}px ${settings.labelFont}`;
    const width = context.measureText(data.label).width;
    const x = data.x + data.size + 6;
    context.beginPath();
    context.roundRect(x - 6, data.y - size / 2 - 5, width + 12, size + 10, 6);
    context.fillStyle = theme.surface;
    context.strokeStyle = theme.border;
    context.lineWidth = 1;
    context.fill();
    context.stroke();
    context.fillStyle = theme.text;
    context.fillText(data.label, x, data.y + size / 3);
  };
}

export interface GraphCanvasProps {
  graph: GraphData;
  colorOf: (id: string) => string;
  theme: GraphTheme;
  selectedId: string | null;
  matches: Set<string> | null;
  onSelect: (id: string | null) => void;
}

export function GraphCanvas({ graph, colorOf, theme, selectedId, matches, onSelect }: GraphCanvasProps) {
  const container = useRef<HTMLDivElement>(null);
  const renderer = useRef<Sigma | null>(null);
  const layout = useRef<{ run: (ms: number) => void; stop: () => void } | null>(null);
  const hovered = useRef<string | null>(null);
  const focus = useRef<{ id: string; neighbors: Set<string> } | null>(null);
  const view = useRef({ colorOf, theme, selectedId, matches, onSelect });
  view.current = { colorOf, theme, selectedId, matches, onSelect };
  const [settling, setSettling] = useState(false);
  const [ready, setReady] = useState(false);

  const refocus = () => {
    const sigma = renderer.current;
    if (!sigma) return;
    const id = hovered.current ?? view.current.selectedId;
    const graphology = sigma.getGraph();
    focus.current = id && graphology.hasNode(id) ? { id, neighbors: new Set(graphology.neighbors(id)) } : null;
    sigma.refresh({ skipIndexation: true });
  };

  useEffect(() => {
    if (!container.current) return;
    let disposed = false;
    let supervisor: FA2Layout | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let observer: ResizeObserver | undefined;

    void Promise.all([
      import("graphology"),
      import("sigma"),
      import("graphology-layout-forceatlas2"),
      import("graphology-layout-forceatlas2/worker"),
    ]).then(([{ default: GraphologyGraph }, { default: SigmaRenderer }, { inferSettings }, { default: Supervisor }]) => {
      if (disposed || !container.current) return;
      const graphology = new GraphologyGraph({ type: "undirected", multi: false, allowSelfLoops: false });

      const settings: Partial<Settings> = {
        renderEdgeLabels: false,
        zIndex: true,
        labelFont: getComputedStyle(document.body).fontFamily,
        labelSize: 12,
        labelWeight: "500",
        labelColor: { color: view.current.theme.text },
        labelDensity: 0.25,
        labelGridCellSize: 180,
        labelRenderedSizeThreshold: 10,
        defaultEdgeColor: view.current.theme.edge,
        defaultDrawNodeHover: hoverDrawer(view.current.theme),
        minCameraRatio: 0.03,
        maxCameraRatio: 3,
        stagePadding: 40,
        nodeReducer: (id, data) => {
          const { colorOf: color, theme: palette, matches: matched } = view.current;
          const result = { ...data, color: color(id) };
          const focused = focus.current;
          if (focused) {
            if (id === focused.id) return { ...result, forceLabel: true, zIndex: 3 };
            if (focused.neighbors.has(id)) return { ...result, forceLabel: focused.neighbors.size <= 14, zIndex: 2 };
            return { ...result, color: palette.dim, label: null, zIndex: 0 };
          }
          if (matched) {
            if (matched.has(id)) return { ...result, forceLabel: matched.size <= 20, zIndex: 2 };
            return { ...result, color: palette.dim, label: null, zIndex: 0 };
          }
          return result;
        },
        edgeReducer: (id, data) => {
          const { theme: palette, matches: matched } = view.current;
          const focused = focus.current;
          if (!focused && !matched) return data;
          const [source, target] = graphology.extremities(id);
          if (focused) {
            if (source === focused.id || target === focused.id) return { ...data, color: palette.edgeFocus, size: 1.5, zIndex: 1 };
            return { ...data, hidden: true };
          }
          if (matched?.has(source) && matched.has(target)) return { ...data, color: palette.edgeFocus };
          return { ...data, hidden: true };
        },
      };

      const sigma = new SigmaRenderer(graphology, container.current, settings);
      renderer.current = sigma;

      sigma.on("enterNode", ({ node }) => {
        hovered.current = node;
        if (container.current) container.current.style.cursor = "pointer";
        refocus();
      });
      sigma.on("leaveNode", () => {
        hovered.current = null;
        if (container.current) container.current.style.cursor = "";
        refocus();
      });
      sigma.on("clickNode", ({ node }) => view.current.onSelect(node));
      sigma.on("clickStage", () => view.current.onSelect(null));

      supervisor = new Supervisor(graphology, {
        settings: { ...inferSettings(900), outboundAttractionDistribution: true, scalingRatio: 6, gravity: 1, barnesHutOptimize: true },
      });
      layout.current = {
        stop: () => {
          clearTimeout(timer);
          if (supervisor?.isRunning()) {
            supervisor.stop();
            savePositions(graphology);
          }
        },
        run: (ms: number) => {
          if (!supervisor) return;
          clearTimeout(timer);
          if (!supervisor.isRunning()) supervisor.start();
          setSettling(true);
          timer = setTimeout(() => {
            supervisor?.stop();
            savePositions(graphology);
            setSettling(false);
          }, ms);
        },
      };

      observer = new ResizeObserver(() => sigma.resize());
      observer.observe(container.current);
      setReady(true);
    });

    return () => {
      disposed = true;
      clearTimeout(timer);
      observer?.disconnect();
      supervisor?.kill();
      renderer.current?.kill();
      renderer.current = null;
      layout.current = null;
      focus.current = null;
    };
  }, []);

  useEffect(() => {
    const sigma = renderer.current;
    if (!ready || !sigma) return;
    const graphology = sigma.getGraph();
    layout.current?.stop();

    const incoming = new Set(graph.nodes.map((node) => node.id));
    graphology.forEachNode((id) => {
      if (!incoming.has(id)) graphology.dropNode(id);
    });

    const neighbors = new Map<string, string[]>();
    for (const [a, b] of graph.edges) {
      if (!graphology.hasNode(a)) neighbors.set(a, [...(neighbors.get(a) ?? []), b]);
      if (!graphology.hasNode(b)) neighbors.set(b, [...(neighbors.get(b) ?? []), a]);
    }

    const saved = loadPositions();
    let fresh = 0;
    graph.nodes.forEach((node, index) => {
      const attributes = { size: nodeSize(node.degree), label: shortLabel(node.preview) };
      if (graphology.hasNode(node.id)) {
        graphology.mergeNodeAttributes(node.id, attributes);
        return;
      }
      let position = saved[node.id];
      if (!position) {
        fresh += 1;
        const anchor = neighbors.get(node.id)?.find((id) => graphology.hasNode(id));
        if (anchor) {
          const { x, y } = graphology.getNodeAttributes(anchor);
          position = [x + (Math.random() - 0.5) * 20, y + (Math.random() - 0.5) * 20];
        } else {
          const angle = index * 2.399963;
          const radius = 10 * Math.sqrt(index + 1);
          position = [Math.cos(angle) * radius, Math.sin(angle) * radius];
        }
      }
      graphology.addNode(node.id, { ...attributes, x: position[0], y: position[1] });
    });

    const wanted = new Set(graph.edges.map(([a, b]) => (a < b ? `${a}|${b}` : `${b}|${a}`)));
    graphology.forEachEdge((edge, _attributes, source, target) => {
      if (!wanted.has(source < target ? `${source}|${target}` : `${target}|${source}`)) graphology.dropEdge(edge);
    });
    for (const [a, b] of graph.edges) {
      if (a !== b && graphology.hasNode(a) && graphology.hasNode(b) && !graphology.hasEdge(a, b)) graphology.addEdge(a, b);
    }

    refocus();
    if (fresh > 0) layout.current?.run(fresh > graph.nodes.length / 4 ? 4000 : 1200);
    else setSettling(false);
  }, [graph, ready]);

  useEffect(() => {
    const sigma = renderer.current;
    if (!sigma) return;
    sigma.setSetting("labelColor", { color: theme.text });
    sigma.setSetting("defaultEdgeColor", theme.edge);
    sigma.setSetting("defaultDrawNodeHover", hoverDrawer(theme));
  }, [theme]);

  useEffect(() => {
    renderer.current?.refresh({ skipIndexation: true });
  }, [colorOf, matches]);

  useEffect(() => {
    refocus();
    const sigma = renderer.current;
    if (!sigma || !selectedId) return;
    const display = sigma.getNodeDisplayData(selectedId);
    if (!display) return;
    const camera = sigma.getCamera();
    const { width } = sigma.getDimensions();
    const shift = width > 900 ? DETAIL_PANEL_WIDTH / 2 : 0;
    const ratio = Math.min(camera.ratio, 0.6);
    const offset = sigma.viewportToFramedGraph({ x: width / 2 + shift, y: 0 }).x - sigma.viewportToFramedGraph({ x: width / 2, y: 0 }).x;
    void camera.animate({ x: display.x + (offset * ratio) / camera.ratio, y: display.y, ratio }, { duration: 450 });
  }, [selectedId]);

  const camera = () => renderer.current?.getCamera();

  return (
    <div className="relative size-full">
      <div ref={container} className="absolute inset-0" />
      <div className="absolute right-3 bottom-3 flex flex-col gap-1 rounded-lg border bg-background/80 p-1 shadow-sm backdrop-blur">
        <Button size="icon-sm" variant="ghost" onClick={() => void camera()?.animatedZoom({ duration: 200 })}>
          <PlusIcon />
          <span className="sr-only">Zoom in</span>
        </Button>
        <Button size="icon-sm" variant="ghost" onClick={() => void camera()?.animatedUnzoom({ duration: 200 })}>
          <MinusIcon />
          <span className="sr-only">Zoom out</span>
        </Button>
        <Button size="icon-sm" variant="ghost" onClick={() => void camera()?.animatedReset({ duration: 300 })}>
          <LocateFixedIcon />
          <span className="sr-only">Fit graph</span>
        </Button>
        <Button size="icon-sm" variant="ghost" disabled={settling} onClick={() => layout.current?.run(2500)}>
          <SparklesIcon />
          <span className="sr-only">Re-run layout</span>
        </Button>
      </div>
      {settling && (
        <div className="absolute top-3 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border bg-background/80 px-3 py-1 text-muted-foreground text-xs shadow-sm backdrop-blur">
          <Spinner className="size-3" />
          Arranging notes…
        </div>
      )}
    </div>
  );
}
