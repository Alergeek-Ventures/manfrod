import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <div className="flex h-[calc(100svh-var(--header-height)-1rem)] min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b px-4 py-3 lg:px-6">
        <Skeleton className="h-8 w-full max-w-xs" />
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-8 w-28" />
      </div>
      <div className="flex gap-3 border-b px-4 py-2.5 lg:px-6">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-5 w-16" />
        ))}
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="hidden w-80 flex-col gap-3 border-r p-4 md:flex xl:w-96">
          {Array.from({ length: 8 }, (_, index) => (
            <Skeleton key={index} className="h-14 w-full" />
          ))}
        </div>
        <div className="flex-1" />
      </div>
    </div>
  );
}
