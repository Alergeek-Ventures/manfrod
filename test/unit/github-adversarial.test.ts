import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userCanRead, userRepositories } from "../../lib/github/access.ts";
import { repositoryReadToken } from "../../lib/github/api.ts";
import { formatPull, type PullFile, type PullDetail } from "../../lib/github/format.ts";

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.GITHUB_APP_ID;
  delete process.env.GITHUB_APP_PRIVATE_KEY;
});

describe("GitHub authorization boundaries", () => {
  it("rechecks repositories after the user token changes", async () => {
    const userId = `token-change-${crypto.randomUUID()}`;
    const secret = {
      id: 91,
      full_name: "acme/secret",
      private: true,
      default_branch: "main",
      archived: false,
    };
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const token = new Headers(init?.headers).get("authorization");
      if (url.endsWith("/user/installations?per_page=100")) {
        return new Response(JSON.stringify({ installations: token === "Bearer old-token" ? [{ id: 7 }] : [] }));
      }
      if (url.endsWith("/user/installations/7/repositories?per_page=100")) {
        return new Response(JSON.stringify({ repositories: [secret] }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetch);

    expect(await userRepositories(userId, "old-token")).toEqual([secret]);
    expect(await userRepositories(userId, "new-token")).toEqual([]);
  });

  it("rechecks explicit repository access after the user token changes", async () => {
    const userId = `access-change-${crypto.randomUUID()}`;
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const token = new Headers(init?.headers).get("authorization");
      return token === "Bearer old-token"
        ? new Response(JSON.stringify({ full_name: "acme/secret" }), { status: 200 })
        : new Response("", { status: 404 });
    });
    vi.stubGlobal("fetch", fetch);

    expect(await userCanRead(userId, "old-token", "acme/secret")).toBe(true);
    expect(await userCanRead(userId, "new-token", "acme/secret")).toBe(false);
  });

  it("requests the permissions needed to read pull request checks", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const fetch = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
      return new Response(JSON.stringify({ token: "installation-token", expires_at: "2099-01-01T00:00:00Z" }), { status: 201 });
    });
    vi.stubGlobal("fetch", fetch);

    await repositoryReadToken(987_000_000 + Math.floor(Math.random() * 1_000_000), `acme/app-${crypto.randomUUID()}`);

    const body = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(body.permissions).toMatchObject({ checks: "read", statuses: "read" });
  });
});

describe("GitHub pull request truncation", () => {
  it("reports omitted files using the pull request's total", () => {
    const pull: PullDetail = {
      number: 42,
      title: "Large change",
      state: "open",
      html_url: "https://github.com/acme/app/pull/42",
      user: { login: "ann" },
      head: { ref: "large", sha: "abc" },
      base: { ref: "main" },
      updated_at: "2026-11-13T10:00:00Z",
      body: null,
      changed_files: 500,
    };
    const files: PullFile[] = Array.from({ length: 300 }, (_, index) => ({
      filename: `file-${index}.ts`,
      status: "modified",
      additions: 1,
      deletions: 0,
    }));

    expect(formatPull("acme/app", pull, files, [], "none")).toContain("…400 more files");
  });
});

describe("GitHub repository read tokens", () => {
  it("falls back to a token without checks when the app lacks that permission", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return body.permissions.checks
        ? new Response("{}", { status: 422 })
        : new Response(JSON.stringify({ token: "read-token", expires_at: "2099-01-01T00:00:00Z" }), { status: 201 });
    });
    vi.stubGlobal("fetch", fetch);

    const installationId = 986_000_000 + Math.floor(Math.random() * 1_000_000);
    expect(await repositoryReadToken(installationId, "acme/one")).toBe("read-token");
    expect(await repositoryReadToken(installationId, "acme/two")).toBe("read-token");
    expect(fetch).toHaveBeenCalledTimes(3);
    const second = JSON.parse(String(fetch.mock.calls[1][1]?.body));
    expect(second).toEqual({
      repositories: ["one"],
      permissions: { contents: "read", metadata: "read", pull_requests: "read", issues: "read" },
    });
  });
});
