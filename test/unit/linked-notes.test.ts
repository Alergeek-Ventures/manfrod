import { describe, expect, it } from "vitest";
import type { Node } from "../../lib/db/schema.ts";
import { MAX_LINKED_NOTES, pickLinkedNotes } from "../../lib/memory/search.ts";

const node = (id: string) => ({ id, content: id }) as Node;

describe("pickLinkedNotes", () => {
  const found = [node("a"), node("b"), node("c")];

  it("caps linked notes and prefers those linked to more results, then to better-ranked ones", () => {
    const links = [
      { node: node("x"), sourceId: "c" },
      { node: node("y"), sourceId: "b" },
      { node: node("z"), sourceId: "a" },
      { node: node("y"), sourceId: "c" },
      { node: node("w"), sourceId: "c" },
    ];
    expect(pickLinkedNotes(found, links).map((item) => item.id)).toEqual(["y", "z", "x"]);
    expect(MAX_LINKED_NOTES).toBe(3);
  });

  it("skips notes that are already results", () => {
    expect(pickLinkedNotes(found, [{ node: node("b"), sourceId: "a" }])).toEqual([]);
  });
});
