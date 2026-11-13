import { describe, expect, it } from "vitest";
import {
  accountStatus,
  encodeOauthCookie,
  newOauthCookie,
  parseInstallationId,
  parseOauthCookie,
  planCallback,
} from "../../lib/github/connect.ts";

const cookie = encodeOauthCookie({ state: "state-1", userId: "user-1" });
const params = (values: Record<string, string>) => new URLSearchParams(values);

describe("GitHub OAuth cookie", () => {
  it("round-trips a fresh state for the user", () => {
    const fresh = newOauthCookie("user-1");
    expect(fresh.state.length).toBeGreaterThan(20);
    expect(parseOauthCookie(encodeOauthCookie(fresh))).toEqual(fresh);
  });

  it("rejects malformed cookies", () => {
    expect(parseOauthCookie(undefined)).toBeNull();
    expect(parseOauthCookie("not json")).toBeNull();
    expect(parseOauthCookie(JSON.stringify({ state: "", userId: "user-1" }))).toBeNull();
    expect(parseOauthCookie(JSON.stringify({ state: "s" }))).toBeNull();
  });
});

describe("parseInstallationId", () => {
  it("accepts positive integers only", () => {
    expect(parseInstallationId("12345")).toBe(12345);
    expect(parseInstallationId(null)).toBeNull();
    expect(parseInstallationId("0")).toBeNull();
    expect(parseInstallationId("-1")).toBeNull();
    expect(parseInstallationId("12abc")).toBeNull();
    expect(parseInstallationId("1".repeat(20))).toBeNull();
  });
});

describe("planCallback", () => {
  it("links the account when state and session match", () => {
    expect(planCallback(params({ code: "c", state: "state-1" }), cookie, "user-1")).toEqual({
      linkUserId: "user-1",
      code: "c",
      installationId: null,
      error: null,
    });
  });

  it("links and syncs after installing with a verified state", () => {
    const plan = planCallback(params({ code: "c", state: "state-1", installation_id: "42", setup_action: "install" }), cookie, "user-1");
    expect(plan).toMatchObject({ linkUserId: "user-1", installationId: 42, error: null });
  });

  it("never links when the state does not match", () => {
    expect(planCallback(params({ code: "c", state: "other" }), cookie, "user-1")).toMatchObject({
      linkUserId: null,
      error: expect.any(String),
    });
  });

  it("never links when another panel user finishes the flow", () => {
    expect(planCallback(params({ code: "c", state: "state-1" }), cookie, "user-2").linkUserId).toBeNull();
    expect(planCallback(params({ code: "c", state: "state-1" }), cookie, null).linkUserId).toBeNull();
  });

  it("only syncs an installation that arrives without a valid state", () => {
    expect(planCallback(params({ code: "c", installation_id: "42", setup_action: "install" }), undefined, "user-1")).toEqual({
      linkUserId: null,
      code: null,
      installationId: 42,
      error: null,
    });
  });

  it("reports a cancelled authorization", () => {
    expect(planCallback(params({ error: "access_denied", state: "state-1" }), cookie, "user-1")).toMatchObject({
      linkUserId: null,
      error: "GitHub authorization was cancelled.",
    });
  });

  it("asks to retry when the code is missing", () => {
    expect(planCallback(params({ state: "state-1" }), cookie, "user-1")).toMatchObject({
      linkUserId: null,
      error: expect.stringContaining("code"),
    });
  });
});

describe("accountStatus", () => {
  const now = new Date("2026-11-13T12:00:00Z");

  it("maps stored accounts to a status", () => {
    expect(accountStatus(null, now)).toBe("not_connected");
    expect(accountStatus({ status: "connected", refreshExpiresAt: null }, now)).toBe("connected");
    expect(accountStatus({ status: "connected", refreshExpiresAt: new Date("2026-12-01") }, now)).toBe("connected");
    expect(accountStatus({ status: "connected", refreshExpiresAt: new Date("2026-11-01") }, now)).toBe("expired");
    expect(accountStatus({ status: "expired", refreshExpiresAt: null }, now)).toBe("expired");
  });
});
