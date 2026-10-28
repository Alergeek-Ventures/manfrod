import { describe, expect, it } from "vitest";
import { isPrivateAddress } from "../../agent/lib/http.ts";
import { hasPlaceholder, hostAllowed, normalizeHosts, redactWith, substituteWith, usableBy, type UsableSecret } from "../../lib/secrets.ts";

const secret = (value: string, allowedHosts: string[], scope: UsableSecret["scope"] = "company"): UsableSecret => ({
  value,
  allowedHosts,
  scope,
});

const secrets = new Map([
  ["SECRET_TEAM_ID", secret("team-123456", ["api.example.com"])],
  ["API_TOKEN", secret("tok_abcdef", ["*.example.com"])],
]);

describe("substituteWith", () => {
  it("replaces placeholders in nested strings for allowed hosts", () => {
    const input = { query: "team {{ SECRET_TEAM_ID }}", headers: [{ auth: "Bearer {{API_TOKEN}}" }], limit: 5 };
    const result = substituteWith(input, secrets, "api.example.com");
    expect(result.value).toEqual({ query: "team team-123456", headers: [{ auth: "Bearer tok_abcdef" }], limit: 5 });
    expect(result.used.sort()).toEqual(["API_TOKEN", "SECRET_TEAM_ID"]);
    expect(result.unknown).toEqual([]);
    expect(result.blocked).toEqual([]);
  });

  it("never sends a secret to a host it wasn't added for", () => {
    const result = substituteWith("{{ API_TOKEN }} {{ SECRET_TEAM_ID }}", secrets, "evil.com");
    expect(result.value).toBe("{{ API_TOKEN }} {{ SECRET_TEAM_ID }}");
    expect(result.blocked.sort()).toEqual(["API_TOKEN", "SECRET_TEAM_ID"]);
  });

  it("reports unknown names and leaves them untouched", () => {
    const result = substituteWith("x {{ MISSING_ONE }}", secrets, "api.example.com");
    expect(result.value).toBe("x {{ MISSING_ONE }}");
    expect(result.unknown).toEqual(["MISSING_ONE"]);
  });

  it("ignores lowercase template syntax", () => {
    expect(hasPlaceholder("{{ name }}")).toBe(false);
    expect(hasPlaceholder({ deep: ["{{ API_TOKEN }}"] })).toBe(true);
  });
});

describe("hosts", () => {
  it("matches exact hosts and wildcard subdomains", () => {
    expect(hostAllowed("api.github.com", ["api.github.com"])).toBe(true);
    expect(hostAllowed("uploads.github.com", ["api.github.com"])).toBe(false);
    expect(hostAllowed("eu.api.example.com", ["*.example.com"])).toBe(true);
    expect(hostAllowed("example.com.evil.io", ["*.example.com"])).toBe(false);
  });

  it("normalizes and validates hosts", () => {
    expect(normalizeHosts(["https://API.GitHub.com/repos", " *.example.com ", ""])).toEqual(["api.github.com", "*.example.com"]);
    expect(() => normalizeHosts(["localhost"])).toThrow(/Invalid host/);
  });
});

describe("usableBy", () => {
  const stored = [
    { name: "SHARED", value: "company-value", scope: "company" as const, ownerUserId: null, allowedHosts: ["a.com"] },
    { name: "SHARED", value: "kamil-value", scope: "personal" as const, ownerUserId: "kamil", allowedHosts: ["a.com"] },
    { name: "NATALIA_TOKEN", value: "natalia-value", scope: "personal" as const, ownerUserId: "natalia", allowedHosts: ["b.com"] },
  ];

  it("gives each person company secrets plus their own, preferring their own", () => {
    const kamil = usableBy(stored, "kamil");
    expect(kamil.get("SHARED")?.value).toBe("kamil-value");
    expect(kamil.has("NATALIA_TOKEN")).toBe(false);
    expect([...usableBy(stored, null).keys()]).toEqual(["SHARED"]);
    expect(usableBy(stored, null).get("SHARED")?.value).toBe("company-value");
  });
});

describe("redactWith", () => {
  it("swaps secret values in output back to placeholders", () => {
    expect(redactWith({ body: "echo tok_abcdef for team-123456" }, secrets)).toEqual({
      body: "echo {{ API_TOKEN }} for {{ SECRET_TEAM_ID }}",
    });
  });

  it("does not redact values too short to be meaningful", () => {
    expect(redactWith("a b c", new Map([["SHORT", secret("b", ["a.com"])]]))).toBe("a b c");
  });
});

describe("isPrivateAddress", () => {
  it("blocks loopback, private, link-local and mapped addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.20.0.5",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "::1",
      "fd00::1",
      "fe80::1",
      "::ffff:10.0.0.1",
    ]) {
      expect(isPrivateAddress(address)).toBe(true);
    }
    for (const address of ["140.82.112.5", "8.8.8.8", "2606:4700::1111"]) {
      expect(isPrivateAddress(address)).toBe(false);
    }
  });
});
