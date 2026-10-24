import { auth } from "@/lib/auth.ts";

export async function GET(request: Request) {
  const url = new URL(request.url);
  url.pathname = "/api/auth/callback/google";
  return auth.handler(new Request(url, request));
}
