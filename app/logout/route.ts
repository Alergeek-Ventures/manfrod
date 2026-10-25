import { NextResponse } from "next/server";
import { auth } from "@/lib/auth.ts";

async function handle(request: Request) {
  const result = await auth.api.signOut({ headers: request.headers, asResponse: true });
  const response = NextResponse.redirect(new URL("/login", request.url), 303);
  for (const cookie of result.headers.getSetCookie()) response.headers.append("set-cookie", cookie);
  return response;
}

export const POST = handle;
export const DELETE = handle;
