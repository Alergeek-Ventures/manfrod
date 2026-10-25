import { NextResponse } from "next/server";
import { config } from "../config.ts";

export function redirectWith(_request: Request, path: string, flash: { error?: string; info?: string }) {
  const url = new URL(path, config.appUrl);
  if (flash.error) url.searchParams.set("error", flash.error);
  if (flash.info) url.searchParams.set("info", flash.info);
  return NextResponse.redirect(url);
}
