"use client";

import { useState } from "react";
import { CheckIcon, ChevronsUpDownIcon, PlusIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { FormDialog, type Run, Section } from "./access-client.tsx";
import { linkGithubBoard, linkGithubRepository, syncGithub, unlinkGithubBoard, unlinkGithubRepository } from "./actions.ts";
import type { GithubData } from "./github-data.ts";

type Project = GithubData["projects"][number];
type Option = { label: string; value: string; group: string };

const formatStamp = (value: string | null) => (value ? value.slice(0, 16).replace("T", " ") : "–");

function groupBy(options: Option[]): [string, Option[]][] {
  const groups = new Map<string, Option[]>();
  for (const option of options) groups.set(option.group, [...(groups.get(option.group) ?? []), option]);
  return [...groups];
}

function GroupedSelect({
  options,
  value,
  placeholder,
  onChange,
}: {
  options: Option[];
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find((option) => option.value === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="outline" className="w-full justify-between font-normal" />}>
        <span className={cn("truncate", !selected && "text-muted-foreground")}>{selected?.label ?? placeholder}</span>
        <ChevronsUpDownIcon className="opacity-50" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--anchor-width) p-0">
        <Command>
          <CommandInput placeholder="Search…" />
          <CommandList>
            <CommandEmpty>No matches.</CommandEmpty>
            {groupBy(options).map(([group, items]) => (
              <CommandGroup key={group} heading={group}>
                {items.map((item) => (
                  <CommandItem
                    key={item.value}
                    value={item.value}
                    keywords={[item.label, group]}
                    onSelect={() => {
                      onChange(item.value);
                      setOpen(false);
                    }}
                  >
                    <span className="truncate">{item.label}</span>
                    {item.value === value && <CheckIcon className="ml-auto" />}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

function AddRepository({ project, data, run, pending }: { project: Project; data: GithubData; run: Run; pending: boolean }) {
  const [selected, setSelected] = useState("");
  const linkedIds = new Set(project.repositories.map((repository) => repository.id));
  const options = data.repositories
    .filter((repository) => !linkedIds.has(repository.id))
    .map((repository) => ({
      label: `${repository.fullName}${repository.archived ? " (archived)" : ""}`,
      value: String(repository.id),
      group: repository.owner,
    }));
  const owners = [...new Set(project.repositories.map((repository) => repository.owner))];
  const chosen = data.repositories.find((repository) => String(repository.id) === selected);
  const foreign = chosen && owners.length > 0 && !owners.includes(chosen.owner);
  return (
    <FormDialog
      trigger={
        <>
          <PlusIcon data-icon="inline-start" />
          Repository
        </>
      }
      title={`Link a repository to ${project.name}`}
      submitLabel="Link"
      pending={pending}
      onSubmit={(close) =>
        selected &&
        run(
          () => linkGithubRepository(project.id, Number(selected)),
          () => {
            close();
            setSelected("");
          },
        )
      }
    >
      <Field>
        <FieldLabel>Repository</FieldLabel>
        <GroupedSelect options={options} value={selected} placeholder="Select a repository" onChange={setSelected} />
      </Field>
      {foreign && (
        <Alert variant="destructive">
          <AlertDescription>
            {chosen.fullName} belongs to {chosen.owner}, while this project&apos;s other repositories belong to {owners.join(", ")}. Linking
            it can expose an internal repository in the project&apos;s channels, client channels included.
          </AlertDescription>
        </Alert>
      )}
    </FormDialog>
  );
}

function AddBoard({ project, data, run, pending }: { project: Project; data: GithubData; run: Run; pending: boolean }) {
  const [selected, setSelected] = useState("");
  const [showClosed, setShowClosed] = useState(false);
  const linkedIds = new Set(project.boards.map((board) => board.boardNodeId));
  const options = data.boards
    .filter((board) => !linkedIds.has(board.nodeId) && (showClosed || !board.closed))
    .map((board) => ({
      label: `${board.title} (#${board.number})${board.closed ? " – closed" : ""}`,
      value: board.nodeId,
      group: board.ownerLogin,
    }));
  return (
    <FormDialog
      trigger={
        <>
          <PlusIcon data-icon="inline-start" />
          Board
        </>
      }
      title={`Link a GitHub Projects board to ${project.name}`}
      submitLabel="Link"
      pending={pending}
      onSubmit={(close) =>
        selected &&
        run(
          () => linkGithubBoard(project.id, selected),
          () => {
            close();
            setSelected("");
          },
        )
      }
    >
      <Field>
        <FieldLabel>Board</FieldLabel>
        <GroupedSelect options={options} value={selected} placeholder="Select a board" onChange={setSelected} />
      </Field>
      <Field orientation="horizontal">
        <Switch id={`closed-${project.id}`} checked={showClosed} onCheckedChange={setShowClosed} />
        <FieldLabel htmlFor={`closed-${project.id}`}>Show closed boards</FieldLabel>
      </Field>
    </FormDialog>
  );
}

function LinkBadge({ label, href, onRemove }: { label: string; href?: string; onRemove: () => void }) {
  return (
    <Badge variant="secondary" className="gap-1">
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" className="hover:underline">
          {label}
        </a>
      ) : (
        label
      )}
      <button type="button" aria-label={`Unlink ${label}`} onClick={onRemove} className="opacity-60 hover:opacity-100">
        <XIcon className="size-3" />
      </button>
    </Badge>
  );
}

export function GithubTab({ data, run, pending }: { data: GithubData; run: Run; pending: boolean }) {
  const boardUrls = new Map(data.boards.map((board) => [board.nodeId, board.url]));
  return (
    <>
      <Section
        title="GitHub installations"
        description="Accounts where the Manfrod GitHub App is installed."
        empty="The GitHub App isn't installed anywhere yet."
        isEmpty={data.installations.length === 0}
        action={
          <Button size="sm" disabled={pending} onClick={() => run(syncGithub)}>
            {pending ? <Spinner data-icon="inline-start" /> : <RefreshCwIcon data-icon="inline-start" />}
            Sync now
          </Button>
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Owner</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Repositories</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Synced</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.installations.map((installation) => (
              <TableRow key={installation.id}>
                <TableCell className="font-medium">{installation.accountLogin}</TableCell>
                <TableCell>{installation.accountType}</TableCell>
                <TableCell className="text-right tabular-nums">{installation.repositoryCount}</TableCell>
                <TableCell>
                  <Badge variant={installation.suspended ? "destructive" : "default"}>
                    {installation.suspended ? "suspended" : "active"}
                  </Badge>
                </TableCell>
                <TableCell className="text-muted-foreground">{formatStamp(installation.syncedAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>
      <Section
        title="Project links"
        description="Repositories and GitHub Projects boards Manfrod uses for each project. Everyone with access to the project's channels can see what is linked."
        empty="No projects yet."
        isEmpty={data.projects.length === 0}
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Project</TableHead>
              <TableHead>Repositories</TableHead>
              <TableHead>Boards</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.projects.map((project) => (
              <TableRow key={project.id}>
                <TableCell className="font-medium">{project.name}</TableCell>
                <TableCell className="whitespace-normal">
                  <div className="flex flex-wrap gap-1">
                    {project.repositories.length === 0 && <span className="text-muted-foreground">–</span>}
                    {project.repositories.map((repository) => (
                      <LinkBadge
                        key={repository.id}
                        label={repository.fullName}
                        href={`https://github.com/${repository.fullName}`}
                        onRemove={() => run(() => unlinkGithubRepository(project.id, repository.id))}
                      />
                    ))}
                  </div>
                </TableCell>
                <TableCell className="whitespace-normal">
                  <div className="flex flex-wrap gap-1">
                    {project.boards.length === 0 && <span className="text-muted-foreground">–</span>}
                    {project.boards.map((board) => (
                      <LinkBadge
                        key={board.boardNodeId}
                        label={`${board.title} (${board.ownerLogin}/${board.number})`}
                        href={boardUrls.get(board.boardNodeId)}
                        onRemove={() => run(() => unlinkGithubBoard(project.id, board.boardNodeId))}
                      />
                    ))}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <AddRepository project={project} data={data} run={run} pending={pending} />
                    <AddBoard project={project} data={data} run={run} pending={pending} />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Section>
    </>
  );
}
