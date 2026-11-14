"use client";

import { CheckIcon, CopyIcon, PencilIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { ConfirmAction } from "@/components/confirm-action";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import type { SelectedNode } from "./actions.ts";

const NONE = "__none__";

const longDate = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  timeZone: "Europe/Warsaw",
});

export function NoteDetailSkeleton({ onClose }: { onClose: () => void }) {
  return (
    <DetailShell onClose={onClose}>
      <div className="flex flex-col gap-3 p-4">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    </DetailShell>
  );
}

function DetailShell({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="absolute inset-y-3 right-3 z-10 flex w-[min(400px,calc(100%-1.5rem))] flex-col overflow-hidden rounded-xl border bg-background/95 shadow-lg backdrop-blur">
      <div className="flex items-center justify-between border-b px-4 py-2.5">
        <span className="font-medium text-sm">Note</span>
        <Button size="icon-sm" variant="ghost" onClick={onClose}>
          <XIcon />
          <span className="sr-only">Close</span>
        </Button>
      </div>
      {children}
    </div>
  );
}

export function NoteDetail({
  node,
  author,
  isSoul,
  projects,
  colorOf,
  pending,
  onClose,
  onOpen,
  onSave,
  onDelete,
  onProject,
}: {
  node: SelectedNode;
  author: string;
  isSoul: boolean;
  projects: { id: string; name: string }[];
  colorOf: (id: string) => string;
  pending: boolean;
  onClose: () => void;
  onOpen: (id: string) => void;
  onSave: (content: string) => Promise<boolean>;
  onDelete: () => void;
  onProject: (projectId: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(node.content);
  const [copied, setCopied] = useState(false);
  const projectItems = [{ label: "No project", value: NONE }, ...projects.map((project) => ({ label: project.name, value: project.id }))];

  return (
    <DetailShell onClose={onClose}>
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <div className="flex flex-wrap items-center gap-1.5">
          {isSoul && <Badge>soul</Badge>}
          <Badge variant={node.processed ? "outline" : "secondary"}>{node.processed ? "processed" : "slipbox"}</Badge>
          <Badge variant="outline">{node.linkCount} links</Badge>
          <span className="ml-auto text-muted-foreground text-xs">{author}</span>
        </div>

        {editing ? (
          <div className="flex flex-col gap-2">
            <Textarea className="min-h-48 text-sm leading-relaxed" value={draft} onChange={(event) => setDraft(event.target.value)} />
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={pending}
                onClick={async () => {
                  if (await onSave(draft)) setEditing(false);
                }}
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
            </div>
          </div>
        ) : (
          <p className="whitespace-pre-wrap text-[15px] leading-relaxed">{node.content}</p>
        )}

        <dl className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Project</dt>
          <dd>
            <Select
              items={projectItems}
              value={node.projectId ?? NONE}
              onValueChange={(value) => value !== null && onProject(value === NONE ? null : (value as string))}
            >
              <SelectTrigger size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {projectItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </dd>
          <dt className="text-muted-foreground">Created</dt>
          <dd className="tabular-nums">{longDate.format(new Date(node.insertedAt))}</dd>
          <dt className="text-muted-foreground">Updated</dt>
          <dd className="tabular-nums">{longDate.format(new Date(node.updatedAt))}</dd>
          <dt className="text-muted-foreground">ID</dt>
          <dd className="flex min-w-0 items-center gap-1">
            <span className="truncate font-mono text-muted-foreground text-xs">{node.id}</span>
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={() => {
                void navigator.clipboard.writeText(node.id);
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              }}
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
              <span className="sr-only">Copy ID</span>
            </Button>
          </dd>
        </dl>

        {!editing && (
          <div className="flex gap-2">
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
              onConfirm={onDelete}
            />
          </div>
        )}

        {node.links.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <h3 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">Linked notes</h3>
            <div className="flex flex-col gap-1">
              {node.links.map((link) => (
                <button
                  key={link.id}
                  type="button"
                  onClick={() => onOpen(link.id)}
                  className="flex items-start gap-2 rounded-lg border px-3 py-2 text-left text-sm transition-colors hover:bg-muted/60"
                >
                  <span className="mt-1.5 size-2 shrink-0 rounded-full" style={{ backgroundColor: colorOf(link.id) }} />
                  <span className="line-clamp-2 leading-snug">{link.preview}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </DetailShell>
  );
}
