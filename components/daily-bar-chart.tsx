"use client"

import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts"

import { formatNumber } from "@/components/section-cards"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart"

export type Series = { key: string; label: string; color?: string }

const COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"]

export function DailyBarChart({
  title,
  description,
  data,
  series,
  stacked = false,
  money = false,
}: {
  title: string
  description?: string
  data: object[]
  series: Series[]
  stacked?: boolean
  money?: boolean
}) {
  const format = (value: number) => (money ? `$${value.toFixed(value < 1 ? 3 : 2)}` : formatNumber(value))
  const config = Object.fromEntries(
    series.map((item, index) => [item.key, { label: item.label, color: item.color ?? COLORS[index % COLORS.length] }])
  ) satisfies ChartConfig
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>
        <ChartContainer config={config} className="aspect-auto h-56 w-full">
          <BarChart data={data} margin={{ left: 0, right: 8 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="date"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              tickFormatter={(value: string) => `${value.slice(8, 10)}.${value.slice(5, 7)}`}
            />
            <YAxis tickLine={false} axisLine={false} width={56} tickFormatter={(value: number) => format(value)} />
            <ChartTooltip content={<ChartTooltipContent indicator="dot" />} />
            <ChartLegend content={<ChartLegendContent />} />
            {series.map((item) => (
              <Bar
                key={item.key}
                dataKey={item.key}
                fill={`var(--color-${item.key})`}
                radius={4}
                stackId={stacked ? "stack" : undefined}
              />
            ))}
          </BarChart>
        </ChartContainer>
      </CardContent>
    </Card>
  )
}
