import Link from "next/link";
import { DailyBarChart } from "@/components/daily-bar-chart";
import { RankedBarChart } from "@/components/ranked-bar-chart";
import { formatNumber, SectionCards } from "@/components/section-cards";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { overview, type Overview } from "@/lib/analytics/index.ts";
import { label as modelLabel } from "@/lib/pricing.ts";
import { requireAdmin } from "@/lib/web/session.ts";

export const dynamic = "force-dynamic";

const RANGES = [7, 30, 90];
const DEFAULT_RANGE = 30;

const money = (value: number) => value.toFixed(4);
const formatDate = (date: string | null) => (date ? `${date.slice(8, 10)}.${date.slice(5, 7)}` : "–");

function formatDateTime(iso: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Warsaw",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${get("day")}.${get("month")} ${get("hour")}:${get("minute")}`;
}

function deltaLabel(current: number, previous: number, suffix: string): string {
  if (previous === 0) return "no prior period";
  const change = Math.round(((current - previous) / previous) * 100);
  return `${change < 0 ? "" : "+"}${change}% ${suffix}`;
}

const rate = (value: number) => (value <= 0 ? "free" : `$${value}`);

function cacheWriteRate(price: Overview["pricing"][number]): string {
  if (typeof price.cache_write_above_per_mtok === "number" && typeof price.cache_write_threshold === "number") {
    return `$${price.cache_write_per_mtok} / $${price.cache_write_above_per_mtok} >${Math.floor(price.cache_write_threshold / 1000)}K`;
  }
  return price.cache_write_per_mtok <= 0 ? "–" : `$${price.cache_write_per_mtok}`;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-4 px-4 lg:px-6">
      <h2 className="text-sm font-medium text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

function NoData({ children }: { children: React.ReactNode }) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>Nothing yet</EmptyTitle>
        <EmptyDescription>{children}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  await requireAdmin();
  const requested = Number((await searchParams).days);
  const days = RANGES.includes(requested) ? requested : DEFAULT_RANGE;
  const data = await overview(days);
  const { summary } = data;
  const modelKeys = data.model_timeline.models.map((model, index) => ({ model, key: `m${index}` }));
  const modelSpend = data.model_timeline.series.map((day) => ({
    date: day.date,
    ...Object.fromEntries(modelKeys.map(({ model, key }) => [key, day.models[model]?.cost_usd ?? 0])),
  }));

  return (
    <div className="flex flex-col gap-6 py-4 md:py-6">
      <div className="flex flex-wrap items-center justify-between gap-4 px-4 lg:px-6">
        <p className="text-sm text-muted-foreground">
          {formatDate(data.range[0])} – {formatDate(data.range[1])}
        </p>
        <div className="flex gap-1">
          {RANGES.map((range) => (
            <Button
              key={range}
              size="sm"
              variant={range === days ? "secondary" : "ghost"}
              nativeButton={false}
              render={<Link href={`/admin/analytics?days=${range}`} />}
            >
              {range}d
            </Button>
          ))}
        </div>
      </div>

      <SectionCards
        metrics={[
          {
            label: "Spend",
            value: `$${money(summary.cost_usd)}`,
            sublabel: deltaLabel(summary.cost_usd, summary.previous_cost_usd, "vs previous period"),
          },
          { label: "Projected / month", value: `$${money(summary.projected_monthly_cost)}`, sublabel: `at the last ${days}d rate` },
          {
            label: "Active people",
            value: summary.active_users,
            sublabel: `of ${summary.total_people} provisioned · reach ${data.adoption.reach}%`,
          },
          { label: "Cache savings", value: `$${money(summary.cache_savings_usd)}`, sublabel: `${summary.cache_hit_rate}% of input cached` },
          {
            label: "Satisfaction",
            value: data.feedback.score === null ? "–" : `${data.feedback.score}%`,
            sublabel: data.feedback.total === 0 ? "no ratings yet" : `${data.feedback.good} good / ${data.feedback.bad} bad`,
          },
        ]}
      />

      <Section title="Adoption">
        <div className="grid grid-cols-1 gap-4 @3xl/main:grid-cols-2">
          <DailyBarChart
            title="Active people per day"
            description="Distinct people who interacted"
            data={data.daily}
            series={[{ key: "active_users", label: "People" }]}
          />
          <DailyBarChart
            title="Conversation volume"
            description="Messages the bot sent per day"
            data={data.daily}
            series={[{ key: "messages_sent", label: "Messages", color: "var(--chart-2)" }]}
          />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Per person</CardTitle>
            <CardDescription>Last {days} days, most active first</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Person</TableHead>
                  {["Msgs in", "Replies", "Sessions", "Tools", "Notes", "Active days", "Calls", "Cost"].map((heading) => (
                    <TableHead key={heading} className="text-right">
                      {heading}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.by_user.map((row) => (
                  <TableRow key={row.user_id}>
                    <TableCell className="font-medium">
                      {row.name} {row.system && <Badge variant="outline">system</Badge>}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{row.messages_received}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.messages_sent}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.sessions}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.tool_calls}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.notes_created}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.active_days}/{days}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{row.calls}</TableCell>
                    <TableCell className="text-right tabular-nums">{row.attributed ? `$${money(row.cost_usd)}` : "–"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
          {data.by_user.some((row) => !row.attributed) && (
            <CardFooter className="text-sm text-muted-foreground">
              &quot;–&quot; means those calls predate per-user cost attribution; totals above still include them.
            </CardFooter>
          )}
        </Card>
      </Section>

      <Section title="Tools">
        <div className="grid grid-cols-1 gap-4 @3xl/main:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Everyday use</CardTitle>
              <CardDescription>Reads, listings, memory fetches — routine calls on the way to an answer</CardDescription>
            </CardHeader>
            <CardContent>
              {data.by_tool.everyday.length === 0 ? (
                <NoData>No tool calls in this window.</NoData>
              ) : (
                <RankedBarChart label="Calls" rows={data.by_tool.everyday.map((tool) => ({ name: tool.tool, value: tool.calls }))} />
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>User intent</CardTitle>
              <CardDescription>An action the user asked for by name — booking a desk, opening the door, a reminder</CardDescription>
            </CardHeader>
            <CardContent>
              {data.by_tool.intent.length === 0 ? (
                <NoData>No intent-driven tool calls in this window.</NoData>
              ) : (
                <RankedBarChart
                  label="Calls"
                  color="var(--chart-2)"
                  rows={data.by_tool.intent.map((tool) => ({ name: tool.tool, value: tool.calls }))}
                />
              )}
            </CardContent>
          </Card>
        </div>
      </Section>

      <Section title="Feedback">
        <Card>
          <CardHeader>
            <CardTitle>Answers rated bad</CardTitle>
            <CardDescription>Last {days} days, newest first</CardDescription>
          </CardHeader>
          <CardContent>
            {data.negative_feedback.length === 0 ? (
              <NoData>
                {data.feedback.total === 0
                  ? "Nobody has rated an answer in this window."
                  : `${data.feedback.good} positive ratings, none negative.`}
              </NoData>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Who</TableHead>
                    <TableHead>Where</TableHead>
                    <TableHead>Message</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.negative_feedback.map((feedback) => (
                    <TableRow key={`${feedback.inserted_at}-${feedback.rater}`}>
                      <TableCell className="tabular-nums text-muted-foreground">{formatDateTime(feedback.inserted_at)}</TableCell>
                      <TableCell className="font-medium">{feedback.rater}</TableCell>
                      <TableCell className="text-muted-foreground">{feedback.where}</TableCell>
                      <TableCell>
                        {feedback.permalink ? (
                          <Button
                            variant="link"
                            size="sm"
                            className="px-0"
                            nativeButton={false}
                            render={<a href={feedback.permalink} target="_blank" rel="noopener" />}
                          >
                            Open in Slack
                          </Button>
                        ) : (
                          <span className="text-muted-foreground">no link</span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </Section>

      <Section title="Models">
        <div className="grid grid-cols-1 gap-4 @3xl/main:grid-cols-2">
          <DailyBarChart
            title="Daily spend by model"
            description="In dollars"
            data={modelSpend}
            stacked
            money
            series={modelKeys.map(({ model, key }) => ({ key, label: modelLabel(model) }))}
          />
          <Card>
            <CardHeader>
              <CardTitle>Cost per model</CardTitle>
              <CardDescription>Whole window</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Model</TableHead>
                    <TableHead className="text-right">Calls</TableHead>
                    <TableHead className="text-right">Tokens in / out</TableHead>
                    <TableHead className="text-right">Cached</TableHead>
                    <TableHead className="text-right">Latency</TableHead>
                    <TableHead className="text-right">Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.by_model.map((model) => (
                    <TableRow key={model.model}>
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2">
                          {model.label}
                          {model.free && <Badge variant="secondary">free</Badge>}
                          {model.unpriced && <Badge variant="destructive">no pricing</Badge>}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{formatNumber(model.calls)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {formatNumber(model.input_tokens)} / {formatNumber(model.output_tokens)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{model.cache_hit_rate}%</TableCell>
                      <TableCell className="text-right tabular-nums">{model.avg_latency_ms}ms</TableCell>
                      <TableCell className="text-right tabular-nums">${money(model.cost_usd)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {data.by_model.some((model) => model.unpriced) && (
                <Alert variant="destructive" className="mt-4">
                  <AlertDescription>
                    A model with no pricing entry is costed at $0 — add it to lib/pricing.ts so spend isn&apos;t understated.
                  </AlertDescription>
                </Alert>
              )}
            </CardContent>
          </Card>
        </div>
        <div className="grid grid-cols-1 gap-4 @3xl/main:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Cost by purpose</CardTitle>
              <CardDescription>Which subsystem spends the budget</CardDescription>
            </CardHeader>
            <CardContent>
              <RankedBarChart
                label="Cost"
                money
                color="var(--chart-3)"
                rows={data.by_purpose.map((purpose) => ({ name: purpose.purpose, value: purpose.cost_usd }))}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Pricing in effect</CardTitle>
              <CardDescription>USD per million tokens</CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Model</TableHead>
                    <TableHead className="text-right">Input</TableHead>
                    <TableHead className="text-right">Output</TableHead>
                    <TableHead className="text-right">Cached in</TableHead>
                    <TableHead className="text-right">Cache write</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.pricing.map((price) => (
                    <TableRow key={price.model}>
                      <TableCell className="font-medium">{price.label}</TableCell>
                      <TableCell className="text-right tabular-nums">{rate(price.input_per_mtok)}</TableCell>
                      <TableCell className="text-right tabular-nums">{rate(price.output_per_mtok)}</TableCell>
                      <TableCell className="text-right tabular-nums">{rate(price.cached_input_per_mtok)}</TableCell>
                      <TableCell className="text-right tabular-nums">{cacheWriteRate(price)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </div>
      </Section>

      <Section title="Weekly">
        <Card>
          <CardHeader>
            <CardTitle>Active people and volume per week</CardTitle>
            <CardDescription>
              avg {data.adoption.avg_daily_active} people/day · stickiness {data.adoption.stickiness} · $
              {money(summary.cost_per_active_user)} per active person · {formatNumber(summary.calls)} LLM calls, {summary.failed_calls}{" "}
              failed, {summary.retries} retries
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Week of</TableHead>
                  <TableHead className="text-right">Active people</TableHead>
                  <TableHead className="text-right">Sessions</TableHead>
                  <TableHead className="text-right">Messages</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.adoption.weekly.map((week) => (
                  <TableRow key={week.week}>
                    <TableCell className="tabular-nums">{formatDate(week.week)}</TableCell>
                    <TableCell className="text-right tabular-nums">{week.active_users}</TableCell>
                    <TableCell className="text-right tabular-nums">{week.sessions}</TableCell>
                    <TableCell className="text-right tabular-nums">{week.messages}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </Section>
    </div>
  );
}
