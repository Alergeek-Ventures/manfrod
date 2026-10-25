"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

export function LiveRefresh({ types, sources }: { types?: string[]; sources?: string[] }) {
  const router = useRouter();
  useEffect(() => {
    const source = new EventSource("/api/activity/stream");
    let timer: ReturnType<typeof setTimeout> | null = null;
    source.onmessage = (message) => {
      const event = JSON.parse(message.data) as { type: string; source: string | null };
      const matches = (types?.includes(event.type) ?? false) || (event.source !== null && (sources?.includes(event.source) ?? false));
      if (!matches || timer) return;
      timer = setTimeout(() => {
        timer = null;
        router.refresh();
      }, 500);
    };
    return () => {
      source.close();
      if (timer) clearTimeout(timer);
    };
  }, [router, types, sources]);
  return null;
}
