import { describe, expect, it } from "vitest";
import type { OpenPull } from "../../lib/github.ts";
import { capabilityGate, describeProposals, isProposal, PROPOSAL_FOOTER } from "../../lib/self-modify-pulls.ts";

const pull = (number: number, title: string, branch = `manfrod/self-modify/${number}`): OpenPull => ({
  number,
  title,
  url: `https://github.com/org/repo/pull/${number}`,
  branch,
  body: `Adds ${title.toLowerCase()}.${PROPOSAL_FOOTER} at the request of Ala.`,
  draft: false,
});

describe("open self-modify proposals", () => {
  it("recognises self-modify branches only", () => {
    expect(isProposal(pull(1, "A"))).toBe(true);
    expect(isProposal(pull(2, "B", "feat/something"))).toBe(false);
  });

  it("describes each pull request without the footer", () => {
    const text = describeProposals([pull(207, "Create Slack canvases")]);
    expect(text).toBe("- #207 Create Slack canvases (ready for review, https://github.com/org/repo/pull/207): Adds create slack canvases.");
  });
});

describe("capabilityGate", () => {
  const open = [pull(207, "Create Slack canvases")];

  it("lets the request through when nothing is open or the agent already checked", () => {
    expect(capabilityGate([], undefined, false)).toEqual({ ok: true, extend: null });
    expect(capabilityGate(open, undefined, true)).toEqual({ ok: true, extend: null });
  });

  it("shows the open pull requests before anything is posted", () => {
    const gate = capabilityGate(open, undefined, false);
    expect(gate.ok).toBe(false);
    if (!gate.ok) {
      expect(gate.message).toContain("#207 Create Slack canvases");
      expect(gate.message).toContain("extend_pull");
    }
  });

  it("extends only a pull request that is open", () => {
    expect(capabilityGate(open, 207, false)).toEqual({ ok: true, extend: open[0] });
    const gate = capabilityGate(open, 99, false);
    expect(gate.ok).toBe(false);
    if (!gate.ok) expect(gate.message).toContain("#99 is not an open self-modify pull request");
  });
});

describe("collectPages", () => {
  it("keeps fetching while pages are full and stops at the first short one", async () => {
    const { collectPages } = await import("../../lib/github.ts");
    const pages = [Array.from({ length: 100 }, (_, index) => index), [100, 101]];
    const requested: number[] = [];
    const all = await collectPages(async (page) => {
      requested.push(page);
      return pages[page - 1] ?? [];
    });
    expect(all).toHaveLength(102);
    expect(requested).toEqual([1, 2]);
  });
});
