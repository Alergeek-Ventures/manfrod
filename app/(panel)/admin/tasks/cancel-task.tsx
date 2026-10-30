"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { ConfirmAction } from "@/components/confirm-action";
import { cancelTask } from "./actions.ts";

export function CancelTask({ id, title }: { id: string; title: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <ConfirmAction
      label={pending ? "Cancelling…" : "Cancel"}
      title={`Cancel "${title}"?`}
      description="Manfrod stops checking on it. People in its thread are not told."
      confirmLabel="Cancel task"
      onConfirm={() =>
        startTransition(async () => {
          const result = await cancelTask(id);
          if (result.ok) toast.success(result.message);
          else toast.error(result.message);
        })
      }
    />
  );
}
