import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installLink, readIntent } from "../../lib/linear/oauth.ts";

const intentFrom = (link: string | null) => new URL(link ?? "").searchParams.get("intent");

describe("Linear install intents", () => {
  beforeEach(() => vi.stubEnv("LINEAR_CLIENT_ID", "client"));
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("round-trips a signed project and Slack user", () => {
    const token = intentFrom(
      installLink({ projectId: "project-1", slackUserId: "U1", responseUrl: "https://hooks.slack.com/actions/T1/2/x" }),
    );
    expect(readIntent(token)).toEqual({ projectId: "project-1", slackUserId: "U1", responseUrl: "https://hooks.slack.com/actions/T1/2/x" });
  });

  it("rejects a token whose payload was swapped", () => {
    const [, signature] = intentFrom(installLink({ projectId: "project-1", slackUserId: "U1" }))!.split(".");
    const forged = Buffer.from(JSON.stringify({ projectId: "project-2", slackUserId: "U1", exp: Date.now() + 60_000 })).toString(
      "base64url",
    );
    expect(readIntent(`${forged}.${signature}`)).toBeNull();
    expect(readIntent("garbage")).toBeNull();
  });

  it("expires after ten minutes unless the caller allows it", () => {
    vi.useFakeTimers();
    const token = intentFrom(installLink({ projectId: "project-1", slackUserId: "U1" }));
    vi.advanceTimersByTime(11 * 60 * 1000);
    expect(readIntent(token)).toBeNull();
    expect(readIntent(token, { allowExpired: true })).toEqual({ projectId: "project-1", slackUserId: "U1", responseUrl: null });
  });
});
