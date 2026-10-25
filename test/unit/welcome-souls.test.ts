import { describe, expect, it } from "vitest";
import { isOwnSoul, parseSoulDraft } from "../../lib/memory/souls.ts";

describe("parseSoulDraft", () => {
  it("treats NONE and blank replies as no soul", () => {
    expect(parseSoulDraft(" NONE \n")).toBeNull();
    expect(parseSoulDraft("")).toBeNull();
    expect(parseSoulDraft("  Jestem luźnym kumplem Kamila.  ")).toBe("Jestem luźnym kumplem Kamila.");
  });
});

describe("isOwnSoul", () => {
  it("accepts only a note private to its own user", () => {
    expect(isOwnSoul({ userId: "u1", access: ["private/u1"] }, "u1")).toBe(true);
    expect(isOwnSoul({ userId: "u1", access: ["internal"] }, "u1")).toBe(false);
    expect(isOwnSoul({ userId: "u2", access: ["private/u1"] }, "u1")).toBe(false);
    expect(isOwnSoul({ userId: "u1", access: ["private/u1", "internal"] }, "u1")).toBe(false);
  });
});
