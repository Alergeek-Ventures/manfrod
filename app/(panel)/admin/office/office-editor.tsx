"use client";

import { useRef, useState } from "react";
import {
  DoorOpenIcon,
  MinusIcon,
  PlusIcon,
  RotateCwIcon,
  SquareDashedIcon,
  SquareIcon,
  Trash2Icon,
  TypeIcon,
  Undo2Icon,
} from "lucide-react";
import { ConfirmAction } from "@/components/confirm-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  clampToGrid,
  DEFAULT_SIZES,
  footprint,
  isSideways,
  nextRotation,
  shortName,
  splitTags,
  type ElementKind,
  type OfficeElement,
  type Placed,
  type Rotation,
} from "@/lib/office/model.ts";
import { STATUS_STYLE } from "@/lib/office/svg.ts";
import { addDesk, removeDesk, saveDesk, saveOfficeElements } from "./actions.ts";
import { useRun } from "./office-sections.tsx";
import type { EditorDesk, EditorLayout, EditorPerson } from "./types.ts";

type Target = { type: "desk" | "element"; id: string };
type Drag = { mode: "move" | "resize"; target: Target; start: { x: number; y: number }; origin: Placed; moved: boolean };
type Geometry = { x: number; y: number; width: number; height: number; rotation: Rotation };

const asGeometry = (item: Placed): Geometry => ({
  x: item.x,
  y: item.y,
  width: item.width,
  height: item.height,
  rotation: item.rotation as Rotation,
});

const NO_OWNER = "none";
const KIND_NAMES: Record<ElementKind, string> = { room: "Room", wall: "Wall", door: "Door", label: "Label" };
const DEFAULT_LABELS: Partial<Record<ElementKind, string>> = { room: "Pokój", label: "Etykieta" };

const newId = (kind: ElementKind) => `${kind}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function gridPoint(svg: SVGSVGElement, clientX: number, clientY: number) {
  const matrix = svg.getScreenCTM();
  if (!matrix) return { x: 0, y: 0 };
  const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
  return { x: point.x, y: point.y };
}

function isPlaced(desk: EditorDesk): desk is EditorDesk & { x: number; y: number } {
  return desk.x !== null && desk.y !== null;
}

function fitInside(geometry: Geometry, grid: { width: number; height: number }): Geometry {
  const box = footprint(geometry);
  const width = Math.min(box.width, grid.width);
  const height = Math.min(box.height, grid.height);
  const { x, y } = clampToGrid({ x: geometry.x, y: geometry.y, width, height }, grid);
  return isSideways(geometry.rotation)
    ? { x, y, width: height, height: width, rotation: geometry.rotation }
    : { x, y, width, height, rotation: geometry.rotation };
}

function ElementShape({ element }: { element: OfficeElement }) {
  const box = footprint(element);
  if (element.kind === "room")
    return (
      <g>
        <rect x={box.x} y={box.y} width={box.width} height={box.height} rx={0.4} fill="#F1F5F9" stroke="#CBD5E1" strokeWidth={0.08} />
        {element.label && (
          <text x={box.x + 0.5} y={box.y + 0.9} fontSize={0.6} fontWeight={700} fill="#64748B" letterSpacing={0.03}>
            {element.label.toUpperCase()}
          </text>
        )}
      </g>
    );
  if (element.kind === "wall") return <rect x={box.x} y={box.y} width={box.width} height={box.height} rx={0.1} fill="#334155" />;
  if (element.kind === "door") {
    const size = Math.min(box.width, box.height);
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    const left = cx - size / 2;
    const top = cy - size / 2;
    return (
      <g transform={`rotate(${element.rotation} ${cx} ${cy})`}>
        <rect x={box.x} y={box.y} width={box.width} height={box.height} fill="transparent" />
        <rect x={left} y={top + size - 0.05} width={size} height={1.05} fill="#FFFFFF" />
        <path
          d={`M ${left} ${top} A ${size} ${size} 0 0 1 ${left + size} ${top + size}`}
          fill="none"
          stroke="#94A3B8"
          strokeWidth={0.07}
          strokeDasharray="0.2 0.15"
        />
        <line x1={left} y1={top + size} x2={left} y2={top} stroke="#475569" strokeWidth={0.15} strokeLinecap="round" />
      </g>
    );
  }
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return (
    <g>
      <rect x={box.x} y={box.y} width={box.width} height={box.height} fill="transparent" />
      <text
        x={cx}
        y={cy}
        fontSize={0.7}
        fontWeight={700}
        fill="#475569"
        textAnchor="middle"
        dominantBaseline="central"
        transform={isSideways(element.rotation) ? `rotate(${element.rotation === 90 ? 90 : -90} ${cx} ${cy})` : undefined}
      >
        {element.label ?? ""}
      </text>
    </g>
  );
}

function DeskShape({ desk, owner }: { desk: EditorDesk & { x: number; y: number }; owner: string | null }) {
  const box = footprint(desk);
  const style = STATUS_STYLE[desk.ownerUserId ? "owner_present" : "free"];
  const seat = {
    0: { cx: box.x + box.width / 2, cy: box.y + box.height },
    90: { cx: box.x, cy: box.y + box.height / 2 },
    180: { cx: box.x + box.width / 2, cy: box.y },
    270: { cx: box.x + box.width, cy: box.y + box.height / 2 },
  }[desk.rotation as 0 | 90 | 180 | 270];
  return (
    <g opacity={desk.active ? 1 : 0.45}>
      {seat && <circle cx={seat.cx} cy={seat.cy} r={0.45} fill="#FFFFFF" stroke={style.stroke} strokeWidth={0.08} />}
      <rect
        x={box.x}
        y={box.y}
        width={box.width}
        height={box.height}
        rx={0.4}
        fill={style.fill}
        stroke={style.stroke}
        strokeWidth={0.1}
        strokeDasharray={desk.active ? undefined : "0.3 0.2"}
      />
      <text
        x={box.x + box.width / 2}
        y={box.y + box.height / 2 - (owner ? 0.4 : 0)}
        fontSize={0.8}
        fontWeight={700}
        fill={style.text}
        textAnchor="middle"
        dominantBaseline="central"
      >
        {desk.label}
      </text>
      {owner && (
        <text
          x={box.x + box.width / 2}
          y={box.y + box.height / 2 + 0.6}
          fontSize={0.6}
          fill={style.text}
          textAnchor="middle"
          dominantBaseline="central"
        >
          {owner}
        </text>
      )}
    </g>
  );
}

export function OfficeEditor({ layout, desks, people }: { layout: EditorLayout; desks: EditorDesk[]; people: EditorPerson[] }) {
  const [elements, setElements] = useState(layout.elements);
  const [deskList, setDeskList] = useState(desks);
  const [synced, setSynced] = useState({ layout, desks });
  if (synced.layout !== layout || synced.desks !== desks) {
    setSynced({ layout, desks });
    setElements(layout.elements);
    setDeskList(desks);
  }
  const [selection, setSelection] = useState<Target | null>(null);
  const [newLabel, setNewLabel] = useState("");
  const drag = useRef<Drag | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const { pending, run } = useRun();

  const grid = { width: layout.width, height: layout.height };
  const ownerNames = new Map(people.map((person) => [person.id, shortName(person.name)]));
  const placed = deskList.filter(isPlaced);
  const tray = deskList.filter((desk) => !isPlaced(desk));
  const selectedDesk = selection?.type === "desk" ? deskList.find((desk) => desk.id === selection.id) : undefined;
  const selectedElement = selection?.type === "element" ? elements.find((element) => element.id === selection.id) : undefined;
  const selectedGeometry: Placed | undefined =
    selectedElement ?? (selectedDesk && isPlaced(selectedDesk) ? (selectedDesk as EditorDesk & { x: number; y: number }) : undefined);

  const commitElements = (next: OfficeElement[]) => run(() => saveOfficeElements(next), { quiet: true });
  const commitDesk = (id: string, geometry: { x: number | null; y: number | null; width?: number; height?: number; rotation?: number }) =>
    run(() => saveDesk(id, geometry), { quiet: true });

  const applyGeometry = (target: Target, geometry: Geometry) => {
    if (target.type === "desk") setDeskList((list) => list.map((desk) => (desk.id === target.id ? { ...desk, ...geometry } : desk)));
    else setElements((list) => list.map((element) => (element.id === target.id ? { ...element, ...geometry } : element)));
  };

  const commit = (target: Target, geometry: Geometry) => {
    if (target.type === "desk") commitDesk(target.id, geometry);
    else commitElements(elements.map((element) => (element.id === target.id ? { ...element, ...geometry } : element)));
  };

  const change = (target: Target, geometry: Geometry) => {
    const fitted = fitInside(geometry, grid);
    applyGeometry(target, fitted);
    commit(target, fitted);
  };

  const startDrag = (event: React.PointerEvent, target: Target, origin: Placed, mode: Drag["mode"]) => {
    if (!svgRef.current || event.button !== 0) return;
    event.stopPropagation();
    setSelection(target);
    svgRef.current.setPointerCapture(event.pointerId);
    svgRef.current.focus();
    drag.current = { mode, target, origin, start: gridPoint(svgRef.current, event.clientX, event.clientY), moved: false };
  };

  const dragGeometry = (current: Drag, point: { x: number; y: number }): Geometry => {
    const dx = Math.round(point.x - current.start.x);
    const dy = Math.round(point.y - current.start.y);
    const origin = asGeometry(current.origin);
    if (current.mode === "move") {
      const { x, y } = clampToGrid({ ...footprint(origin), x: origin.x + dx, y: origin.y + dy }, grid);
      return { x, y, width: origin.width, height: origin.height, rotation: origin.rotation };
    }
    const box = footprint(origin);
    const width = Math.max(1, Math.min(grid.width - origin.x, box.width + dx));
    const height = Math.max(1, Math.min(grid.height - origin.y, box.height + dy));
    return isSideways(origin.rotation)
      ? { x: origin.x, y: origin.y, width: height, height: width, rotation: origin.rotation }
      : { x: origin.x, y: origin.y, width, height, rotation: origin.rotation };
  };

  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const current = drag.current;
    if (!current || !svgRef.current) return;
    const geometry = dragGeometry(current, gridPoint(svgRef.current, event.clientX, event.clientY));
    const { origin } = current;
    if (
      geometry.x === origin.x &&
      geometry.y === origin.y &&
      geometry.width === origin.width &&
      geometry.height === origin.height &&
      !current.moved
    )
      return;
    current.moved = true;
    applyGeometry(current.target, geometry);
  };

  const onPointerUp = (event: React.PointerEvent<SVGSVGElement>) => {
    const current = drag.current;
    drag.current = null;
    if (!current?.moved || !svgRef.current) return;
    commit(current.target, dragGeometry(current, gridPoint(svgRef.current, event.clientX, event.clientY)));
  };

  const rotate = () => {
    if (!selection || !selectedGeometry) return;
    change(selection, { ...asGeometry(selectedGeometry), rotation: nextRotation(selectedGeometry.rotation) });
  };

  const deleteElement = (id: string) => {
    const next = elements.filter((element) => element.id !== id);
    setElements(next);
    setSelection(null);
    commitElements(next);
  };

  const addElement = (kind: ElementKind) => {
    const size = DEFAULT_SIZES[kind];
    const element: OfficeElement = {
      id: newId(kind),
      kind,
      x: Math.max(0, Math.floor((grid.width - size.width) / 2)),
      y: Math.max(0, Math.floor((grid.height - size.height) / 2)),
      width: Math.min(size.width, grid.width),
      height: Math.min(size.height, grid.height),
      rotation: 0,
      label: DEFAULT_LABELS[kind],
    };
    const next = [...elements, element];
    setElements(next);
    setSelection({ type: "element", id: element.id });
    commitElements(next);
  };

  const placeDesk = (desk: EditorDesk, center?: { x: number; y: number }) => {
    const box = footprint({ x: 0, y: 0, width: desk.width, height: desk.height, rotation: desk.rotation });
    const at = center ?? { x: grid.width / 2, y: grid.height / 2 };
    change(
      { type: "desk", id: desk.id },
      {
        x: Math.round(at.x - box.width / 2),
        y: Math.round(at.y - box.height / 2),
        width: desk.width,
        height: desk.height,
        rotation: desk.rotation as Rotation,
      },
    );
    setSelection({ type: "desk", id: desk.id });
  };

  const unplaceDesk = (desk: EditorDesk) => {
    setDeskList((list) => list.map((item) => (item.id === desk.id ? { ...item, x: null, y: null } : item)));
    commitDesk(desk.id, { x: null, y: null });
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (!selection || !selectedGeometry) return;
    const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (step) {
      event.preventDefault();
      change(selection, { ...asGeometry(selectedGeometry), x: selectedGeometry.x + step[0], y: selectedGeometry.y + step[1] });
    } else if (event.key === "r" || event.key === "R") rotate();
    else if ((event.key === "Delete" || event.key === "Backspace") && selection.type === "element") deleteElement(selection.id);
    else if (event.key === "Escape") setSelection(null);
  };

  const selectionBox = selectedGeometry ? footprint(selectedGeometry) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Office map</CardTitle>
        <CardDescription>
          Drag to move, pull the corner to resize. Everything snaps to the grid. Arrow keys nudge, R rotates, Delete removes a shape.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <form
            className="flex items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (newLabel.trim() === "") return;
              const size = DEFAULT_SIZES.desk;
              const position = { x: Math.floor((grid.width - size.width) / 2), y: Math.floor((grid.height - size.height) / 2) };
              run(() => addDesk(newLabel.trim(), position), {
                onSuccess: (result) => {
                  setNewLabel("");
                  if (result.id) setSelection({ type: "desk", id: result.id });
                },
              });
            }}
          >
            <Input className="h-7 w-28" placeholder="Desk label" value={newLabel} onChange={(event) => setNewLabel(event.target.value)} />
            <Button type="submit" size="sm" disabled={pending || newLabel.trim() === ""}>
              <PlusIcon data-icon="inline-start" />
              Desk
            </Button>
          </form>
          <div className="mx-1 h-5 w-px bg-border" />
          <Button size="sm" variant="outline" onClick={() => addElement("room")}>
            <SquareDashedIcon data-icon="inline-start" />
            Room
          </Button>
          <Button size="sm" variant="outline" onClick={() => addElement("wall")}>
            <MinusIcon data-icon="inline-start" />
            Wall
          </Button>
          <Button size="sm" variant="outline" onClick={() => addElement("door")}>
            <DoorOpenIcon data-icon="inline-start" />
            Door
          </Button>
          <Button size="sm" variant="outline" onClick={() => addElement("label")}>
            <TypeIcon data-icon="inline-start" />
            Label
          </Button>
          {pending && <Spinner className="ml-auto" />}
        </div>

        <div className="grid gap-4 @5xl/main:grid-cols-[minmax(0,1fr)_300px]">
          <div className="overflow-auto rounded-lg border bg-white">
            <svg
              ref={svgRef}
              tabIndex={0}
              role="application"
              aria-label="Office map editor"
              viewBox={`-0.5 -0.5 ${grid.width + 1} ${grid.height + 1}`}
              className="block h-auto w-full min-w-[640px] touch-none outline-none select-none"
              onPointerDown={() => setSelection(null)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={() => (drag.current = null)}
              onKeyDown={onKeyDown}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => {
                event.preventDefault();
                const desk = deskList.find((item) => item.id === event.dataTransfer.getData("text/desk-id"));
                if (desk && svgRef.current) placeDesk(desk, gridPoint(svgRef.current, event.clientX, event.clientY));
              }}
              fontFamily="ui-sans-serif, system-ui, sans-serif"
            >
              <defs>
                <pattern id="office-grid" width={1} height={1} patternUnits="userSpaceOnUse">
                  <path d="M 1 0 L 0 0 0 1" fill="none" stroke="#EEF2F7" strokeWidth={0.05} />
                </pattern>
                <pattern id="office-grid-major" width={5} height={5} patternUnits="userSpaceOnUse">
                  <rect width={5} height={5} fill="url(#office-grid)" />
                  <path d="M 5 0 L 0 0 0 5" fill="none" stroke="#DDE3EA" strokeWidth={0.07} />
                </pattern>
              </defs>
              <rect
                x={0}
                y={0}
                width={grid.width}
                height={grid.height}
                fill="url(#office-grid-major)"
                stroke="#CBD5E1"
                strokeWidth={0.08}
              />
              {[...elements]
                .sort((a, b) => ["room", "wall", "door", "label"].indexOf(a.kind) - ["room", "wall", "door", "label"].indexOf(b.kind))
                .map((element) => (
                  <g
                    key={element.id}
                    className="cursor-move"
                    onPointerDown={(event) => startDrag(event, { type: "element", id: element.id }, element, "move")}
                  >
                    <ElementShape element={element} />
                  </g>
                ))}
              {placed.map((desk) => (
                <g
                  key={desk.id}
                  className="cursor-move"
                  onPointerDown={(event) => startDrag(event, { type: "desk", id: desk.id }, desk, "move")}
                >
                  <DeskShape desk={desk} owner={desk.ownerUserId ? (ownerNames.get(desk.ownerUserId) ?? null) : null} />
                </g>
              ))}
              {selection && selectionBox && selectedGeometry && (
                <g>
                  <rect
                    x={selectionBox.x - 0.15}
                    y={selectionBox.y - 0.15}
                    width={selectionBox.width + 0.3}
                    height={selectionBox.height + 0.3}
                    rx={0.3}
                    fill="none"
                    stroke="#2563EB"
                    strokeWidth={0.08}
                    strokeDasharray="0.3 0.2"
                    pointerEvents="none"
                  />
                  <rect
                    x={selectionBox.x + selectionBox.width - 0.45}
                    y={selectionBox.y + selectionBox.height - 0.45}
                    width={0.9}
                    height={0.9}
                    rx={0.15}
                    fill="#FFFFFF"
                    stroke="#2563EB"
                    strokeWidth={0.1}
                    className="cursor-nwse-resize"
                    onPointerDown={(event) => startDrag(event, selection, selectedGeometry, "resize")}
                  />
                </g>
              )}
            </svg>
          </div>

          <div className="flex flex-col gap-4">
            {selectedDesk ? (
              <DeskPanel
                key={selectedDesk.id}
                desk={selectedDesk}
                people={people}
                pending={pending}
                run={run}
                onRotate={isPlaced(selectedDesk) ? rotate : undefined}
                onPlace={() => placeDesk(selectedDesk)}
                onUnplace={() => unplaceDesk(selectedDesk)}
                onDeleted={() => setSelection(null)}
              />
            ) : selectedElement ? (
              <ElementPanel
                key={selectedElement.id}
                element={selectedElement}
                onRotate={rotate}
                onDelete={() => deleteElement(selectedElement.id)}
                onLabel={(label) => {
                  const next = elements.map((element) =>
                    element.id === selectedElement.id ? { ...element, label: label || undefined } : element,
                  );
                  setElements(next);
                  commitElements(next);
                }}
              />
            ) : (
              <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
                Select a desk or a shape to edit it. Add rooms and walls first, then drag desks from the tray onto the map.
              </p>
            )}

            <div className="flex flex-col gap-2">
              <h3 className="text-sm font-medium">Not on the map</h3>
              {tray.length === 0 ? (
                <p className="text-sm text-muted-foreground">Every desk is placed.</p>
              ) : (
                <ul className="flex flex-wrap gap-2">
                  {tray.map((desk) => (
                    <li key={desk.id}>
                      <button
                        type="button"
                        draggable
                        onDragStart={(event) => {
                          event.dataTransfer.setData("text/desk-id", desk.id);
                          event.dataTransfer.effectAllowed = "move";
                        }}
                        onClick={() => setSelection({ type: "desk", id: desk.id })}
                        className={`flex cursor-grab items-center gap-1.5 rounded-md border px-2.5 py-1 text-sm active:cursor-grabbing ${
                          selection?.id === desk.id ? "border-primary bg-primary/5" : "bg-muted/40 hover:bg-muted"
                        } ${desk.active ? "" : "opacity-60"}`}
                      >
                        <SquareIcon className="size-3.5 text-muted-foreground" />
                        {desk.label}
                        {!desk.active && <span className="text-xs text-muted-foreground">inactive</span>}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-xs text-muted-foreground">Drag a desk onto the map, or select it and press Place.</p>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function ElementPanel({
  element,
  onRotate,
  onDelete,
  onLabel,
}: {
  element: OfficeElement;
  onRotate: () => void;
  onDelete: () => void;
  onLabel: (label: string) => void;
}) {
  const [label, setLabel] = useState(element.label ?? "");
  return (
    <div className="flex flex-col gap-4 rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <span className="font-medium">{KIND_NAMES[element.kind]}</span>
        <Badge variant="secondary">
          {element.width}×{element.height} · {element.rotation}°
        </Badge>
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onLabel(label.trim());
        }}
      >
        <Field>
          <FieldLabel htmlFor="element-label">Label</FieldLabel>
          <div className="flex gap-2">
            <Input id="element-label" value={label} onChange={(event) => setLabel(event.target.value)} />
            <Button type="submit" variant="outline" disabled={label.trim() === (element.label ?? "")}>
              Save
            </Button>
          </div>
        </Field>
      </form>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={onRotate}>
          <RotateCwIcon data-icon="inline-start" />
          Rotate
        </Button>
        <Button variant="ghost" size="sm" className="text-destructive" onClick={onDelete}>
          <Trash2Icon data-icon="inline-start" />
          Delete
        </Button>
      </div>
    </div>
  );
}

function DeskPanel({
  desk,
  people,
  pending,
  run,
  onRotate,
  onPlace,
  onUnplace,
  onDeleted,
}: {
  desk: EditorDesk;
  people: EditorPerson[];
  pending: boolean;
  run: ReturnType<typeof useRun>["run"];
  onRotate?: () => void;
  onPlace: () => void;
  onUnplace: () => void;
  onDeleted: () => void;
}) {
  const [form, setForm] = useState({
    label: desk.label,
    locationNote: desk.locationNote ?? "",
    equipment: desk.equipment.join(", "),
    ownerUserId: desk.ownerUserId ?? NO_OWNER,
    active: desk.active,
  });
  const owners = [{ label: "No owner", value: NO_OWNER }, ...people.map((person) => ({ label: person.name, value: person.id }))];
  const placed = isPlaced(desk);
  return (
    <form
      className="flex flex-col gap-4 rounded-lg border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        run(() =>
          saveDesk(desk.id, {
            label: form.label,
            locationNote: form.locationNote.trim() === "" ? null : form.locationNote.trim(),
            equipment: splitTags(form.equipment),
            ownerUserId: form.ownerUserId === NO_OWNER ? null : form.ownerUserId,
            active: form.active,
          }),
        );
      }}
    >
      <div className="flex items-center justify-between">
        <span className="font-medium">Desk {desk.label}</span>
        <Badge variant={placed ? "secondary" : "outline"}>
          {placed ? `${desk.width}×${desk.height} · ${desk.rotation}°` : "not placed"}
        </Badge>
      </div>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="desk-label">Label</FieldLabel>
          <Input id="desk-label" value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} />
        </Field>
        <Field>
          <FieldLabel htmlFor="desk-equipment">Equipment</FieldLabel>
          <Input
            id="desk-equipment"
            placeholder="usb-c, mac_mini"
            value={form.equipment}
            onChange={(event) => setForm({ ...form, equipment: event.target.value })}
          />
          <FieldDescription>Comma-separated tags people can ask for.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="desk-note">Location note</FieldLabel>
          <Input id="desk-note" value={form.locationNote} onChange={(event) => setForm({ ...form, locationNote: event.target.value })} />
        </Field>
        <Field>
          <FieldLabel>Owner</FieldLabel>
          <Select
            items={owners}
            value={form.ownerUserId}
            onValueChange={(value) => setForm({ ...form, ownerUserId: (value as string) ?? NO_OWNER })}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {owners.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <FieldDescription>Others can book an owned desk only when its owner is away.</FieldDescription>
        </Field>
        <Field orientation="horizontal">
          <Switch id="desk-active" checked={form.active} onCheckedChange={(checked) => setForm({ ...form, active: checked })} />
          <FieldLabel htmlFor="desk-active">Bookable</FieldLabel>
        </Field>
      </FieldGroup>
      <Button type="submit" disabled={pending}>
        {pending && <Spinner data-icon="inline-start" />}
        Save desk
      </Button>
      <div className="flex flex-wrap gap-2">
        {placed ? (
          <>
            <Button type="button" variant="outline" size="sm" onClick={onRotate}>
              <RotateCwIcon data-icon="inline-start" />
              Rotate
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={onUnplace}>
              <Undo2Icon data-icon="inline-start" />
              Off the map
            </Button>
          </>
        ) : (
          <Button type="button" variant="outline" size="sm" onClick={onPlace}>
            <PlusIcon data-icon="inline-start" />
            Place
          </Button>
        )}
        <ConfirmAction
          label={
            <>
              <Trash2Icon data-icon="inline-start" />
              Delete
            </>
          }
          title={`Delete desk ${desk.label}?`}
          description="Its bookings are deleted too. To keep the history, turn off Bookable instead."
          confirmLabel="Delete desk"
          onConfirm={() => run(() => removeDesk(desk.id), { onSuccess: onDeleted })}
        />
      </div>
    </form>
  );
}
