import { MessagesSquareIcon } from "lucide-react";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { requireAdmin } from "@/lib/web/session.ts";

export const dynamic = "force-dynamic";

export default async function ChatPage() {
  await requireAdmin();
  return (
    <Empty className="flex-1">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <MessagesSquareIcon />
        </EmptyMedia>
        <EmptyTitle>Chat</EmptyTitle>
        <EmptyDescription>Chat UI coming soon.</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}
