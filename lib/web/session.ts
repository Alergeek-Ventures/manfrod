import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getUser, isAdmin } from "../accounts.ts";
import { auth } from "../auth.ts";
import type { User } from "../db/schema.ts";

export async function currentUser(): Promise<User | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  return session ? getUser(session.user.id) : null;
}

export async function requireUser(): Promise<User> {
  const user = await currentUser();
  if (!user) redirect(`/login?error=${encodeURIComponent("You must sign in to access this page.")}`);
  return user;
}

export async function requireAdmin(): Promise<User> {
  const user = await requireUser();
  if (!isAdmin(user)) redirect("/integrations");
  return user;
}

export function homeFor(user: User): string {
  return isAdmin(user) ? "/" : "/integrations";
}
