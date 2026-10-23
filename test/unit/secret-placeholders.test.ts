import { describe, expect, it } from "vitest";
import { hasPlaceholder, redactWith, substituteWith } from "../../lib/secrets.ts";

const values = new Map([
  ["SECRET_TEAM_ID", "team-123456"],
  ["API_TOKEN", "tok_abcdef"],
]);

describe("substituteWith", () => {
  it("replaces placeholders in nested strings and reports which were used", () => {
    const input = { query: "team {{ SECRET_TEAM_ID }}", headers: [{ auth: "Bearer {{API_TOKEN}}" }], limit: 5 };
    const result = substituteWith(input, values);
    expect(result.value).toEqual({ query: "team team-123456", headers: [{ auth: "Bearer tok_abcdef" }], limit: 5 });
    expect(result.used.sort()).toEqual(["API_TOKEN", "SECRET_TEAM_ID"]);
    expect(result.unknown).toEqual([]);
  });

  it("reports unknown names and leaves them untouched", () => {
    const result = substituteWith("x {{ MISSING_ONE }}", values);
    expect(result.value).toBe("x {{ MISSING_ONE }}");
    expect(result.unknown).toEqual(["MISSING_ONE"]);
  });

  it("ignores lowercase template syntax", () => {
    expect(hasPlaceholder("{{ name }}")).toBe(false);
    expect(hasPlaceholder({ deep: ["{{ API_TOKEN }}"] })).toBe(true);
  });
});

describe("redactWith", () => {
  it("swaps secret values in output back to placeholders", () => {
    expect(redactWith({ body: "echo tok_abcdef for team-123456" }, values)).toEqual({ body: "echo {{ API_TOKEN }} for {{ SECRET_TEAM_ID }}" });
  });

  it("does not redact values too short to be meaningful", () => {
    expect(redactWith("a b c", new Map([["SHORT", "b"]]))).toBe("a b c");
  });
});
