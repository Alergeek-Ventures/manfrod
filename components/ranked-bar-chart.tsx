"use client";

import { Bar, BarChart, XAxis, YAxis } from "recharts";

import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";

export function RankedBarChart({
  rows,
  label,
  color = "var(--chart-1)",
  money = false,
}: {
  rows: { name: string; value: number }[];
  label: string;
  color?: string;
  money?: boolean;
}) {
  const config = { value: { label, color } } satisfies ChartConfig;
  return (
    <ChartContainer config={config} className="aspect-auto w-full" style={{ height: Math.max(80, rows.length * 28) }}>
      <BarChart data={rows} layout="vertical" margin={{ left: 0, right: 16 }}>
        <XAxis type="number" hide />
        <YAxis type="category" dataKey="name" tickLine={false} axisLine={false} width={150} />
        <ChartTooltip
          content={
            <ChartTooltipContent hideLabel={false} formatter={(value) => (money ? `$${Number(value).toFixed(4)}` : String(value))} />
          }
        />
        <Bar dataKey="value" fill="var(--color-value)" radius={4} />
      </BarChart>
    </ChartContainer>
  );
}
