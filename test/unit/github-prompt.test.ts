import { describe, expect, it } from "vitest";
import { projectGithubPrompt } from "../../lib/github/prompt.ts";

const repositories = [{ fullName: "acme/app", defaultBranch: "main" }];
const boards = [{ ownerLogin: "acme", number: 3, title: "Sprint" }];

describe("projectGithubPrompt", () => {
  it("names the project's repositories and boards and keeps the rest reachable in internal channels", () => {
    const prompt = projectGithubPrompt("Firmowid", repositories, boards, false);
    expect(prompt).toContain("project Firmowid");
    expect(prompt).toContain("acme/app (default branch main)");
    expect(prompt).toContain('acme/3 "Sprint"');
    expect(prompt).toContain("can still read any other repository");
  });

  it("says only the project's repositories are available in client channels", () => {
    expect(projectGithubPrompt("Firmowid", repositories, [], true)).toContain("only these are available here");
  });

  it("adds nothing when the project has no GitHub links", () => {
    expect(projectGithubPrompt("Firmowid", [], [], false)).toBe("");
  });
});
