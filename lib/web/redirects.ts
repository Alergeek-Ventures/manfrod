import { NextResponse } from "next/server";

export function redirectWith(request: Request, path: string, flash: { error?: string; info?: string }) {
  const url = new URL(path, request.url);
  if (flash.error) url.searchParams.set("error", flash.error);
  if (flash.info) url.searchParams.set("info", flash.info);
  return NextResponse.redirect(url);
}
