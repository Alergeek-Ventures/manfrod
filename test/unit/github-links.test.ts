import { describe, expect, it } from "vitest";
import { type AvailableBoard, matchBoards, parseBoardRef } from "../../lib/github/boards.ts";
import { crossOwnerWarning } from "../../lib/github/projects.ts";

const board = (ownerLogin: string, number: number, title: string): AvailableBoard => ({
  nodeId: `PVT_${ownerLogin}_${number}`,
  ownerLogin,
  number,
  title,
  closed: false,
  url: `https://github.com/orgs/${ownerLogin}/projects/${number}`,
});

const boards = [board("acme", 1, "Roadmap"), board("acme", 2, "Sprint"), board("client-co", 3, "Sprint")];

describe("parseBoardRef", () => {
  it("reads owner/number, owner#number and board URLs", () => {
    expect(parseBoardRef("acme/12")).toEqual({ ownerLogin: "acme", number: 12 });
    expect(parseBoardRef(" acme#3 ")).toEqual({ ownerLogin: "acme", number: 3 });
    expect(parseBoardRef("@acme/3")).toEqual({ ownerLogin: "acme", number: 3 });
    expect(parseBoardRef("https://github.com/orgs/acme/projects/7/views/1")).toEqual({ ownerLogin: "acme", number: 7 });
    expect(parseBoardRef("https://github.com/orgs/acme/projects/7")).toEqual({ ownerLogin: "acme", number: 7 });
    expect(parseBoardRef("https://github.com/users/ann/projects/2?query=x")).toEqual({ ownerLogin: "ann", number: 2 });
  });

  it("treats anything else as a title", () => {
    expect(parseBoardRef("Q4 roadmap")).toEqual({ title: "Q4 roadmap" });
    expect(parseBoardRef("acme/web")).toEqual({ title: "acme/web" });
  });
});

describe("matchBoards", () => {
  it("matches by owner and number regardless of case", () => {
    expect(matchBoards("ACME/2", boards).map((row) => row.nodeId)).toEqual(["PVT_acme_2"]);
    expect(matchBoards("acme/9", boards)).toEqual([]);
  });

  it("matches exact titles and reports every board with the same title", () => {
    expect(matchBoards("roadmap", boards)).toHaveLength(1);
    expect(matchBoards("Sprint", boards)).toHaveLength(2);
    expect(matchBoards("Road", boards)).toEqual([]);
  });
});

describe("crossOwnerWarning", () => {
  it("stays quiet when every repository has the same owner", () => {
    expect(crossOwnerWarning(["client-co/app"], ["Client-Co/api"])).toBeNull();
    expect(crossOwnerWarning([], ["acme/a", "acme/b"])).toBeNull();
    expect(crossOwnerWarning(["acme/a"], [])).toBeNull();
  });

  it("names repositories of another owner", () => {
    const warning = crossOwnerWarning(["client-co/app"], ["client-co/api", "acme/internal"]);
    expect(warning).toContain("acme/internal");
    expect(warning).not.toContain("client-co/api,");
    expect(warning).toContain("client-co");
  });

  it("warns when a first batch mixes owners", () => {
    expect(crossOwnerWarning([], ["client-co/app", "acme/internal"])).toContain("acme/internal");
  });
});
