import { describe, expect, it } from "vitest";
import { iconLinks, siteOrigins } from "../../lib/mcp/logo.ts";

describe("siteOrigins", () => {
  it("tries the main site before the MCP subdomain", () => {
    expect(siteOrigins("https://mcp.granola.ai/mcp")).toEqual(["https://granola.ai", "https://mcp.granola.ai"]);
  });

  it("keeps a server that already runs on the main domain", () => {
    expect(siteOrigins("https://firmowid.pl/mcp")).toEqual(["https://firmowid.pl"]);
  });

  it("understands two-part public suffixes", () => {
    expect(siteOrigins("https://mcp.example.com.pl/sse")).toEqual(["https://example.com.pl", "https://mcp.example.com.pl"]);
    expect(siteOrigins("https://example.co.uk/mcp")).toEqual(["https://example.co.uk"]);
  });

  it("does not climb to a shared hosting domain", () => {
    expect(siteOrigins("https://my-tool.vercel.app/mcp")).toEqual(["https://my-tool.vercel.app"]);
  });
});

describe("iconLinks", () => {
  const html = `
    <link rel="icon" href="/favicon/favicon.ico" sizes="any"/>
    <link rel="icon" href="/favicon/favicon-96x96.png" sizes="96x96" type="image/png"/>
    <link rel="icon" href="/favicon/favicon.svg" type="image/svg+xml"/>
    <link rel="mask-icon" href="/safari.svg"/>
    <link rel="stylesheet" href="/app.css"/>
    <link rel="apple-touch-icon" href="/favicon/apple-touch-icon.png" sizes="180x180"/>`;

  it("prefers the touch icon, then svg, then the largest bitmap", () => {
    expect(iconLinks(html, "https://www.granola.ai/")).toEqual([
      "https://www.granola.ai/favicon/apple-touch-icon.png",
      "https://www.granola.ai/favicon/favicon.svg",
      "https://www.granola.ai/favicon/favicon-96x96.png",
      "https://www.granola.ai/favicon/favicon.ico",
    ]);
  });

  it("reads unquoted attributes and shortcut icons", () => {
    expect(iconLinks("<link rel='shortcut icon' href=//cdn.example.com/i.png>", "https://example.com")).toEqual([
      "https://cdn.example.com/i.png",
    ]);
  });
});
