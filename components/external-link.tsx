import { Button } from "@/components/ui/button";

export function ExternalLink({ href, children }: { href: string | null; children: React.ReactNode }) {
  if (!href) return <span className="text-muted-foreground">–</span>;
  return (
    <Button variant="link" size="sm" className="h-auto px-0" nativeButton={false} render={<a href={href} target="_blank" rel="noopener" />}>
      {children}
    </Button>
  );
}
