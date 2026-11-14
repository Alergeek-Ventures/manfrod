"use client";

import { LinkIcon } from "lucide-react";
import { memo } from "react";
import { Badge } from "@/components/ui/badge";
import type { GraphNodeData } from "@/lib/memory/nodes.ts";

const shortDate = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "Europe/Warsaw" });

export interface NoteMeta {
  color: string;
  project: string | null;
  author: string;
  degree: number;
}

const NoteRow = memo(function NoteRow({
  note,
  meta,
  selected,
  onSelect,
}: {
  note: GraphNodeData;
  meta: NoteMeta;
  selected: boolean;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      type="button"
      data-selected={selected}
      onClick={() => onSelect(note.id)}
      className="flex w-full flex-col gap-1.5 rounded-lg px-3 py-2.5 text-left transition-colors [contain-intrinsic-size:auto_76px] [content-visibility:auto] hover:bg-muted/60 data-[selected=true]:bg-muted"
    >
      <p className="line-clamp-2 text-sm leading-snug">{note.preview}</p>
      <div className="flex min-w-0 items-center gap-2 text-muted-foreground text-xs">
        <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: meta.color }} />
        <span className="truncate">{meta.project ?? "No project"}</span>
        <span className="shrink-0">·</span>
        <span className="truncate">{meta.author}</span>
        <span className="ml-auto flex shrink-0 items-center gap-1 tabular-nums">
          <LinkIcon className="size-3" />
          {meta.degree}
        </span>
        <span className="shrink-0 tabular-nums">{shortDate.format(new Date(note.insertedAt))}</span>
      </div>
      {!note.processed && (
        <Badge variant="secondary" className="h-4 px-1.5 text-[10px]">
          slipbox
        </Badge>
      )}
    </button>
  );
});

export function NoteList({
  notes,
  metas,
  selectedId,
  onSelect,
}: {
  notes: GraphNodeData[];
  metas: Map<string, NoteMeta>;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  if (notes.length === 0) return <p className="px-3 py-8 text-center text-muted-foreground text-sm">No notes match.</p>;
  return (
    <div className="flex flex-col gap-0.5 p-2">
      {notes.map((note) => (
        <NoteRow key={note.id} note={note} meta={metas.get(note.id)!} selected={note.id === selectedId} onSelect={onSelect} />
      ))}
    </div>
  );
}
