import { generateKeyPairSync } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const enabled = Boolean(process.env.TEST_DATABASE_URL);
if (enabled) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

const { db, tables } = await import("../../lib/db/index.ts");
const store = await import("../../lib/github/store.ts");
const { queueBackfills, syncAll } = await import("../../lib/github/sync.ts");
const { inngest } = await import("../../lib/inngest/client.ts");
const { inArray } = await import("drizzle-orm");

const base = 960_000_000 + Math.floor(Math.random() * 1_000_000);
const gone = base;
const flaky = base + 1;

const installation = (id: number) => ({
  id,
  account: { id, login: `org-${id}`, type: "Organization" },
  repository_selection: "all",
});

describe.skipIf(!enabled)("GitHub full sync", () => {
  beforeAll(async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    await store.upsertInstallation(installation(gone));
    await store.upsertInstallation(installation(flaky));
  });

  afterEach(() => vi.unstubAllGlobals());

  afterAll(async () => {
    await db.delete(tables.githubInstallations).where(inArray(tables.githubInstallations.id, [gone, flaky]));
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY;
  });

  it("removes only installations GitHub confirms are gone when the list comes back empty", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/app/installations?")) return new Response("[]", { status: 200 });
        if (url.endsWith(`/app/installations/${gone}`)) return new Response("", { status: 404 });
        if (url.endsWith(`/app/installations/${flaky}`)) return new Response("", { status: 502 });
        return new Response("[]", { status: 200 });
      }),
    );
    await syncAll();
    const ids = (await store.listInstallations()).map((row) => row.id);
    expect(ids).not.toContain(gone);
    expect(ids).toContain(flaky);
  });

  it("queues a sync for installations whose repositories still need their history", async () => {
    await store.upsertRepositories(flaky, [{ id: flaky + 100, full_name: `org-${flaky}/app`, private: true, default_branch: "main" }]);
    const send = vi.spyOn(inngest, "send").mockResolvedValue({ ids: [] } as never);
    await queueBackfills();
    expect(send).toHaveBeenCalledWith({ name: "manfrod/github.installation.changed", data: { installationId: flaky } });
    send.mockRestore();
  });
});
