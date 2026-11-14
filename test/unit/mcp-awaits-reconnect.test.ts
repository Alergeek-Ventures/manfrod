import { describe, expect, it } from "vitest";
import { awaitsReconnect } from "../../lib/mcp/index.ts";

describe("awaitsReconnect", () => {
  const notified = new Date("2026-10-25T13:15:01Z");

  it("skips connections the user has to reconnect", () => {
    expect(awaitsReconnect({ status: "expired", notifiedExpiredAt: notified })).toBe(true);
    expect(awaitsReconnect({ status: "disconnected", notifiedExpiredAt: null })).toBe(true);
  });

  it("keeps checking live connections and expired ones the user was not told about yet", () => {
    expect(awaitsReconnect({ status: "connected", notifiedExpiredAt: null })).toBe(false);
    expect(awaitsReconnect({ status: "expired", notifiedExpiredAt: null })).toBe(false);
  });
});
