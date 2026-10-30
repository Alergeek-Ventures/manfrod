import Link from "next/link";
import { ExternalLink } from "@/components/external-link";
import { SectionCards } from "@/components/section-cards";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatLocal } from "@/lib/time.ts";
import { loadSelfReview } from "@/lib/web/agent-work.ts";
import { requireAdmin } from "@/lib/web/session.ts";

export const dynamic = "force-dynamic";

const GROUPS = {
  waiting: { label: "Waiting", statuses: ["open"] },
  progress: { label: "In progress", statuses: ["in_progress", "proposed"] },
  done: { label: "Done", statuses: ["merged"] },
  rejected: { label: "Rejected", statuses: ["dismissed", "closed", "unresolved"] },
} as const;
type Group = keyof typeof GROUPS;

const FINDING_STATUSES: Record<string, { label: string; hint: string; variant: React.ComponentProps<typeof Badge>["variant"] }> = {
  open: { label: "waiting", hint: "needs more ratings or a free slot", variant: "secondary" },
  in_progress: { label: "fixing", hint: "self-modify is working on it", variant: "default" },
  proposed: { label: "PR open", hint: "waiting for review and merge", variant: "default" },
  merged: { label: "merged", hint: "fixed and deployed", variant: "outline" },
  closed: { label: "PR closed", hint: "closed without merging", variant: "destructive" },
  unresolved: { label: "unresolved", hint: "self-modify found no fix", variant: "destructive" },
  dismissed: { label: "dismissed", hint: "already fixed by hand or not worth fixing", variant: "secondary" },
};

const CASE_STATUSES: Record<string, string> = {
  needs_input: "unclear, rater will be asked",
  asked: "rater asked, waiting for an answer",
  not_actionable: "not actionable",
  expired: "rater never answered",
};

const stamp = (date: Date | null) => (date ? formatLocal(date) : "–");
const ratingLabel = (rating: string) => (rating === "bad" ? "👎" : "inferred");

function NoData({ children }: { children: React.ReactNode }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>Nothing here</EmptyTitle>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export default async function SelfReviewPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  await requireAdmin();
  const requested = (await searchParams).status;
  const group = requested && requested in GROUPS ? (requested as Group) : null;
  const data = await loadSelfReview();
  const inGroup = (key: Group) => data.findings.filter((finding) => (GROUPS[key].statuses as readonly string[]).includes(finding.status));
  const findings = group ? inGroup(group) : data.findings;
  const waitingCases = data.cases.filter((row) => row.status === "needs_input" || row.status === "asked");
  const closedCases = data.cases.filter((row) => row.status === "not_actionable" || row.status === "expired").slice(0, 50);
  const verdict = (key: string) => data.verdicts[key] ?? 0;

  return (
    <div className="flex flex-col gap-6 py-4 md:py-6">
      <SectionCards
        metrics={[
          { label: "Ratings to triage", value: data.untriaged, sublabel: "picked up by the next nightly run" },
          { label: "Waiting", value: inGroup("waiting").length, sublabel: `${waitingCases.length} rater question(s) open` },
          { label: "In progress", value: inGroup("progress").length, sublabel: `${data.openPulls} self-modify PR(s) open` },
          { label: "Done", value: inGroup("done").length, sublabel: "merged fixes" },
          { label: "Rejected", value: inGroup("rejected").length, sublabel: "dismissed, closed or unresolved" },
        ]}
      />

      <section className="flex flex-col gap-4 px-4 lg:px-6">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="mr-2 text-sm font-medium text-muted-foreground">Findings</h2>
          <Button variant={group ? "ghost" : "secondary"} size="sm" nativeButton={false} render={<Link href="/admin/self-review" />}>
            All
          </Button>
          {(Object.keys(GROUPS) as Group[]).map((key) => (
            <Button
              key={key}
              variant={group === key ? "secondary" : "ghost"}
              size="sm"
              nativeButton={false}
              render={<Link href={`/admin/self-review?status=${key}`} />}
            >
              {GROUPS[key].label}
            </Button>
          ))}
        </div>
        <Card>
          <CardContent>
            {findings.length === 0 ? (
              <NoData>Findings appear after the nightly self-review groups bad ratings into problems.</NoData>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Finding</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead className="text-right">Severity</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Evidence</TableHead>
                    <TableHead>Pull request</TableHead>
                    <TableHead>Found</TableHead>
                    <TableHead>Resolved</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {findings.map((finding) => {
                    const status = FINDING_STATUSES[finding.status];
                    return (
                      <TableRow key={finding.id} className="align-top">
                        <TableCell className="max-w-lg min-w-72 whitespace-normal">
                          <details>
                            <summary className="cursor-pointer font-medium">{finding.title}</summary>
                            <div className="mt-2 flex flex-col gap-2 text-muted-foreground">
                              <p>
                                <span className="text-foreground">Problem:</span> {finding.problem}
                              </p>
                              <p>
                                <span className="text-foreground">Expected:</span> {finding.expected}
                              </p>
                              {finding.summary && <p>{finding.summary}</p>}
                              {finding.session && <ExternalLink href={finding.session}>Self-modify thread</ExternalLink>}
                            </div>
                          </details>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline">{finding.category}</Badge>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{finding.severity}</TableCell>
                        <TableCell>
                          <Badge variant={status?.variant ?? "secondary"} title={status?.hint}>
                            {status?.label ?? finding.status}
                          </Badge>
                        </TableCell>
                        <TableCell className="whitespace-normal">
                          <div className="flex flex-wrap gap-x-2">
                            {finding.evidence.length === 0 && <span className="text-muted-foreground">–</span>}
                            {finding.evidence.map((item) => (
                              <ExternalLink key={item.id} href={item.link}>
                                {ratingLabel(item.rating)} {item.rater ?? "?"}
                              </ExternalLink>
                            ))}
                          </div>
                        </TableCell>
                        <TableCell>
                          <ExternalLink href={finding.pullUrl}>{finding.pullNumber ? `#${finding.pullNumber}` : "PR"}</ExternalLink>
                        </TableCell>
                        <TableCell className="tabular-nums text-muted-foreground">{stamp(finding.insertedAt)}</TableCell>
                        <TableCell className="tabular-nums text-muted-foreground">{stamp(finding.resolvedAt)}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </section>

      <section className="flex flex-col gap-4 px-4 lg:px-6">
        <h2 className="text-sm font-medium text-muted-foreground">Ratings not turned into findings</h2>
        <div className="grid gap-4 @5xl/main:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Waiting for the rater</CardTitle>
              <CardDescription>Unclear ratings; Manfrod asks the person on a weekday morning.</CardDescription>
            </CardHeader>
            <CardContent>
              {waitingCases.length === 0 ? (
                <NoData>No open questions.</NoData>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Rater</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Question</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {waitingCases.map((row) => (
                      <TableRow key={row.id} className="align-top">
                        <TableCell>
                          {ratingLabel(row.rating)} {row.rater ?? "?"}
                        </TableCell>
                        <TableCell className="whitespace-normal text-muted-foreground">
                          {CASE_STATUSES[row.status]}
                          {row.askedAt && <div className="tabular-nums">{stamp(row.askedAt)}</div>}
                        </TableCell>
                        <TableCell className="max-w-sm whitespace-normal">{row.question ?? row.reason ?? "–"}</TableCell>
                        <TableCell>
                          <ExternalLink href={row.clarification ?? row.link}>Open</ExternalLink>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Set aside</CardTitle>
              <CardDescription>Ratings judged not actionable, or whose rater never answered.</CardDescription>
            </CardHeader>
            <CardContent>
              {closedCases.length === 0 ? (
                <NoData>Nothing set aside.</NoData>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Rater</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Reason</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {closedCases.map((row) => (
                      <TableRow key={row.id} className="align-top">
                        <TableCell>
                          {ratingLabel(row.rating)} {row.rater ?? "?"}
                          <div className="tabular-nums text-muted-foreground">{stamp(row.insertedAt)}</div>
                        </TableCell>
                        <TableCell className="whitespace-normal text-muted-foreground">{CASE_STATUSES[row.status]}</TableCell>
                        <TableCell className="max-w-sm whitespace-normal">{row.reason ?? "–"}</TableCell>
                        <TableCell>
                          <ExternalLink href={row.link}>Open</ExternalLink>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
        <p className="text-sm text-muted-foreground">
          Conversations judged in the last {data.sessionWindowDays} days: {verdict("satisfied")} satisfied, {verdict("unsatisfied")}{" "}
          unhappy, {verdict("unclear")} unclear, {verdict("skipped")} skipped.
        </p>
      </section>
    </div>
  );
}
