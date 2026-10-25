import { describe, expect, it } from "vitest";
import { bucketReadableLevels } from "../../lib/memory/retrospector.ts";

describe("bucketReadableLevels", () => {
  it("keeps a private bucket to its owner's space", () => {
    expect(bucketReadableLevels(["private/u1"])).toEqual(["private/u1"]);
  });

  it("hides the owner's private notes once a note is shared with the team", () => {
    expect(bucketReadableLevels(["private/u1", "internal"])).toEqual(["internal", "external/all"]);
  });

  it("hides internal-only notes from a client bucket", () => {
    expect(bucketReadableLevels(["internal", "external/acme"])).toEqual(["external/acme", "external/all"]);
  });

  it("reads only public notes for a bucket every client sees", () => {
    expect(bucketReadableLevels(["internal", "external/all"])).toEqual(["external/all"]);
  });

  it("lets the internal bucket read internal and public notes", () => {
    expect(bucketReadableLevels(["internal"])).toEqual(["internal", "external/all"]);
  });
});
