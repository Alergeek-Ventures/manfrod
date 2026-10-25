import { redirect } from "next/navigation";
import { BotIcon } from "lucide-react";

import { LoginForm } from "@/components/login-form";
import { currentUser, homeFor } from "@/lib/web/session.ts";

export const dynamic = "force-dynamic";

const AUTH_ERRORS: Record<string, string> = {
  signup_disabled: "No Manfrod account uses this email yet. Message the bot on Slack first, then sign in again.",
  account_not_linked: "This Google account can't be linked to your Manfrod user.",
  email_not_found: "Google didn't share an email address for this account.",
};

function describeError(error: string | undefined) {
  if (!error) return undefined;
  return AUTH_ERRORS[error] ?? (error.includes(" ") ? error : `Sign-in failed (${error}). Only @alergeek.ventures accounts are allowed.`);
}

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const user = await currentUser();
  if (user) redirect(homeFor(user));
  const { error } = await searchParams;
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted p-6 md:p-10">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex items-center gap-2 self-center font-medium">
          <div className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
            <BotIcon className="size-4" />
          </div>
          Manfrod
        </div>
        <LoginForm error={describeError(error)} />
      </div>
    </div>
  );
}
