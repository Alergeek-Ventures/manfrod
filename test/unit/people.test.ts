import { beforeEach, describe, expect, it, vi } from "vitest";

const accounts = vi.hoisted(() => ({
  users: [] as Record<string, any>[],
  created: [] as unknown[][],
}));
const slack = vi.hoisted(() => ({
  workspaceMembers: vi.fn(),
  fetchUserInfo: vi.fn(async () => null as { name: string | null; email: string | null } | null),
  openDm: vi.fn(async (id: string) => `D-${id}`),
}));

vi.mock("../../lib/accounts.ts", () => ({
  getUser: async (id: string) => accounts.users.find((user) => user.id === id) ?? null,
  getUserByEmail: async (email: string) => accounts.users.find((user) => user.email === email) ?? null,
  getUserBySlackId: async (slackId: string) => accounts.users.find((user) => user.slackId === slackId) ?? null,
  listUsers: async () => accounts.users,
  isUuid: (value: string) => /^[0-9a-f-]{36}$/.test(value),
  isSystemUser: (user: { slackId: string }) => user.slackId.startsWith("system:"),
  findOrCreateBySlackId: async (slackId: string, dm: string, name: string | null, email: string | null) => {
    accounts.created.push([slackId, dm, name, email]);
    const user = { id: `id-${slackId}`, slackId, name, email, banned: false };
    accounts.users.push(user);
    return user;
  },
}));
vi.mock("../../lib/slack/api.ts", () => slack);

const { resolvePerson } = await import("../../lib/people.ts");

const member = (id: string, realName: string, extra: Record<string, unknown> = {}) => ({
  id,
  handle: realName.split(" ")[0].toLowerCase(),
  realName,
  displayName: null,
  email: `${id.toLowerCase()}@firma.test`,
  deleted: false,
  bot: false,
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  accounts.users = [
    { id: "id-staszek", slackId: "USTASZEK", name: "Stanisław Nowak", email: null, banned: false },
    { id: "id-kamil", slackId: "UKAMIL", name: "Kamil Marczak", email: null, banned: false },
  ];
  accounts.created = [];
  slack.workspaceMembers.mockResolvedValue([
    member("U0CJSLX9WNT", "Mariusz Ciastoń"),
    member("U0CK4Q772J1", "odul"),
    member("UBOT", "Odul Bot", { bot: true }),
    member("UGONE", "Zenon Stary", { deleted: true }),
    member("UANNA1", "Anna Kowalska"),
    member("UANNA2", "Anna Nowak"),
  ]);
});

describe("resolvePerson", () => {
  it("finds local people by name, first name and diacritics without asking Slack", async () => {
    expect(await resolvePerson("kamil")).toMatchObject({ ok: true, user: { id: "id-kamil" } });
    expect(await resolvePerson("Stanislaw Nowak")).toMatchObject({ ok: true, user: { id: "id-staszek" } });
    expect(slack.workspaceMembers).not.toHaveBeenCalled();
  });

  it("adds a workspace member who never talked to Manfrod, found by name", async () => {
    const match = await resolvePerson("Odul");
    expect(match).toMatchObject({ ok: true, user: { slackId: "U0CK4Q772J1" } });
    expect(accounts.created).toEqual([["U0CK4Q772J1", "D-U0CK4Q772J1", "odul", "u0ck4q772j1@firma.test"]]);
    expect(await resolvePerson("Mariusz")).toMatchObject({ ok: true, user: { slackId: "U0CJSLX9WNT", name: "Mariusz Ciastoń" } });
  });

  it("adds a workspace member from a mention", async () => {
    expect(await resolvePerson("<@U0CJSLX9WNT|mariusz>")).toMatchObject({ ok: true, user: { slackId: "U0CJSLX9WNT" } });
    expect(accounts.created).toHaveLength(1);
  });

  it("refuses bots, deactivated accounts, ambiguous names and people Slack doesn't know", async () => {
    expect(await resolvePerson("Zenon")).toMatchObject({ ok: false, unknown: true });
    expect(await resolvePerson("Anna")).toMatchObject({ ok: false, unknown: false });
    expect((await resolvePerson("Anna")) as { message: string }).toMatchObject({ message: expect.stringContaining("UANNA1") });
    expect(await resolvePerson("Bartosz")).toMatchObject({ ok: false, unknown: true });
    expect(await resolvePerson("<@UGONE>")).toMatchObject({ ok: false, unknown: true });
    expect(accounts.created).toEqual([]);
  });

  it("returns an existing account instead of adding it again and skips banned ones", async () => {
    accounts.users.push({ id: "id-mariusz", slackId: "U0CJSLX9WNT", name: null, email: null, banned: false });
    expect(await resolvePerson("Mariusz")).toMatchObject({ ok: true, user: { id: "id-mariusz" } });
    accounts.users.push({ id: "id-odul", slackId: "U0CK4Q772J1", name: null, email: null, banned: true });
    expect(await resolvePerson("odul")).toMatchObject({ ok: false, unknown: true });
    expect(accounts.created).toEqual([]);
  });

  it("falls back to unknown when Slack can't be read", async () => {
    slack.workspaceMembers.mockResolvedValue(null);
    expect(await resolvePerson("Odul")).toMatchObject({ ok: false, unknown: true });
  });
});
