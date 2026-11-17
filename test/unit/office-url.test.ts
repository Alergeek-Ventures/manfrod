import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dateFromMapFile, deskMapPath, deskMapUrl, verifyDeskMapSignature } from "../../lib/office/url.ts";

const saved = { app: process.env.APP_URL, secret: process.env.INTERNAL_API_SECRET };

beforeAll(() => {
  process.env.APP_URL = "https://manfrod.example.com/";
  process.env.INTERNAL_API_SECRET = "test-secret";
});

afterAll(() => {
  process.env.APP_URL = saved.app;
  process.env.INTERNAL_API_SECRET = saved.secret;
  if (saved.app === undefined) delete process.env.APP_URL;
  if (saved.secret === undefined) delete process.env.INTERNAL_API_SECRET;
});

const parts = (url: string) => {
  const parsed = new URL(url, "https://x.test");
  return { file: parsed.pathname.split("/").pop()!, v: parsed.searchParams.get("v"), sig: parsed.searchParams.get("sig") };
};

describe("desk map URLs", () => {
  it("builds a signed, versioned PNG URL on the app host", () => {
    const url = deskMapUrl("2026-11-17", 3);
    expect(url).toMatch(/^https:\/\/manfrod\.example\.com\/desk-map\/2026-11-17\.png\?v=3&sig=[\w-]+$/);
    const { file, v, sig } = parts(url);
    expect(dateFromMapFile(file)).toBe("2026-11-17");
    expect(verifyDeskMapSignature("2026-11-17", v, sig)).toBe(true);
  });

  it("rejects a changed date, version or signature", () => {
    const { v, sig } = parts(deskMapPath("2026-11-17", 3));
    expect(verifyDeskMapSignature("2026-11-18", v, sig)).toBe(false);
    expect(verifyDeskMapSignature("2026-11-17", "4", sig)).toBe(false);
    expect(verifyDeskMapSignature("2026-11-17", v, `${sig}x`)).toBe(false);
    expect(verifyDeskMapSignature("2026-11-17", v, null)).toBe(false);
    expect(verifyDeskMapSignature("2026-11-17", null, sig)).toBe(false);
  });

  it("rejects signatures made with another secret", () => {
    const { v, sig } = parts(deskMapPath("2026-11-17", 1));
    process.env.INTERNAL_API_SECRET = "other";
    expect(verifyDeskMapSignature("2026-11-17", v, sig)).toBe(false);
    process.env.INTERNAL_API_SECRET = "test-secret";
  });

  it("only accepts real dates as file names", () => {
    expect(dateFromMapFile("2026-02-30.png")).toBeNull();
    expect(dateFromMapFile("2026-11-17.jpg")).toBeNull();
    expect(dateFromMapFile("../2026-11-17.png")).toBeNull();
  });
});
