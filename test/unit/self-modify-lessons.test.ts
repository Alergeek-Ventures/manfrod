import { describe, expect, it } from "vitest";
import { describeLessons, isHumanCommit, parseLessons } from "../../lib/self-modify-lessons.ts";

describe("self-modify lessons", () => {
  it("treats only people's commits as corrections", () => {
    expect(isHumanCommit({ authorLogin: "qamarq" })).toBe(true);
    expect(isHumanCommit({ authorLogin: "manfrod-ai[bot]" })).toBe(false);
    expect(isHumanCommit({ authorLogin: null })).toBe(false);
  });

  it("keeps up to three non-empty lessons from the model's JSON", () => {
    expect(parseLessons('```json\n["a", " ", "b", "c", "d"]\n```')).toEqual(["a", "b", "c"]);
    expect(parseLessons("no lessons here")).toEqual([]);
    expect(parseLessons('{"lesson": "a"}')).toEqual([]);
  });

  it("lists lessons with the pull request they came from", () => {
    expect(describeLessons([])).toBe("No lessons yet.");
    expect(describeLessons([{ pullNumber: 208, lesson: "Check membership for canvas IDs too" }])).toContain(
      "- Check membership for canvas IDs too (#208)",
    );
  });
});
