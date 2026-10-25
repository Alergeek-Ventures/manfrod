import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";

export type Metric = {
  label: string;
  value: React.ReactNode;
  sublabel?: React.ReactNode;
};

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(Math.round(n / 100_000) / 10).toFixed(1)}M`;
  if (n >= 1_000) return `${(Math.round(n / 100) / 10).toFixed(1)}K`;
  return String(n);
}

export function SectionCards({ metrics }: { metrics: Metric[] }) {
  return (
    <div className="grid grid-cols-1 gap-4 px-4 *:data-[slot=card]:bg-linear-to-t *:data-[slot=card]:from-primary/5 *:data-[slot=card]:to-card *:data-[slot=card]:shadow-xs lg:px-6 @xl/main:grid-cols-2 @5xl/main:grid-cols-5 dark:*:data-[slot=card]:bg-card">
      {metrics.map((metric) => (
        <Card key={metric.label} className="@container/card">
          <CardHeader>
            <CardDescription>{metric.label}</CardDescription>
            <CardTitle className="text-2xl font-semibold tabular-nums @[250px]/card:text-3xl">{metric.value}</CardTitle>
          </CardHeader>
          {metric.sublabel && <CardFooter className="text-sm text-muted-foreground">{metric.sublabel}</CardFooter>}
        </Card>
      ))}
    </div>
  );
}
