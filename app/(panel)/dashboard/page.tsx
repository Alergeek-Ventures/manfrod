import { DailyBarChart } from "@/components/daily-bar-chart";
import { formatNumber, SectionCards } from "@/components/section-cards";
import { aggregateLlmMetrics } from "@/lib/events/store.ts";
import { requireAdmin } from "@/lib/web/session.ts";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  await requireAdmin();
  const { totals, daily } = await aggregateLlmMetrics(7);
  const cacheRate = totals.input_tokens > 0 ? `${Math.round((totals.cached_tokens / totals.input_tokens) * 1000) / 10}% of input` : "no input yet";

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <SectionCards
        metrics={[
          { label: "LLM calls · 7 days", value: totals.free_calls + totals.paid_calls, sublabel: `${totals.free_calls} free / ${totals.paid_calls} paid` },
          {
            label: "Tokens",
            value: formatNumber(totals.input_tokens + totals.output_tokens),
            sublabel: `${formatNumber(totals.input_tokens)} in / ${formatNumber(totals.output_tokens)} out`,
          },
          { label: "Cached input", value: formatNumber(totals.cached_tokens), sublabel: cacheRate },
          {
            label: "Messages",
            value: totals.messages_received + totals.messages_sent,
            sublabel: `${totals.messages_received} received / ${totals.messages_sent} sent`,
          },
          {
            label: "Retries / fallbacks",
            value: totals.retries + totals.fallbacks,
            sublabel: `${totals.retries} retries / ${totals.fallbacks} fallbacks`,
          },
        ]}
      />
      <div className="grid grid-cols-1 gap-4 px-4 lg:px-6 @3xl/main:grid-cols-2">
        <DailyBarChart title="LLM calls by tier" data={daily} stacked series={[{ key: "free_calls", label: "Free" }, { key: "paid_calls", label: "Paid" }]} />
        <DailyBarChart title="Token usage" data={daily} series={[{ key: "input_tokens", label: "Input" }, { key: "output_tokens", label: "Output" }]} />
        <DailyBarChart
          title="Prompt cache"
          data={daily}
          series={[{ key: "cached_tokens", label: "Cache read" }, { key: "cache_creation_tokens", label: "Cache write" }]}
        />
        <DailyBarChart title="Messages" data={daily} series={[{ key: "messages_received", label: "Received" }, { key: "messages_sent", label: "Sent" }]} />
        <DailyBarChart title="Retries & fallbacks" data={daily} stacked series={[{ key: "retries", label: "Retries" }, { key: "fallbacks", label: "Fallbacks" }]} />
        <DailyBarChart title="Tool calls" data={daily} series={[{ key: "tool_calls", label: "Tools" }]} />
      </div>
    </div>
  );
}
