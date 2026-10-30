import { describe, expect, it } from "vitest";
import { noteProjectId, projectContext } from "../../lib/memory/classifier.ts";

const projects = [
  { id: "p-manfrod", slug: "manfrod", name: "Manfrod" },
  { id: "p-firmowid", slug: "firmowid", name: "Firmowid" },
];

describe("noteProjectId", () => {
  it("keeps the channel's project unless the classifier names another one", () => {
    expect(noteProjectId(projects, "p-manfrod", { action: "create_memory" })).toBe("p-manfrod");
    expect(noteProjectId(projects, "p-manfrod", { project: "manfrod" })).toBe("p-manfrod");
    expect(noteProjectId(projects, "p-manfrod", { project: "Firmowid" })).toBe("p-firmowid");
    expect(noteProjectId(projects, "p-manfrod", { project: null })).toBeNull();
    expect(noteProjectId(projects, "p-manfrod", { project: "kalafiornia" })).toBeNull();
    expect(noteProjectId(projects, null, { project: "firmowid" })).toBeNull();
  });

  it("describes the channel's project only when there is one", () => {
    expect(projectContext(projects, "p-manfrod")).toBe(
      'This channel belongs to project "manfrod" (Manfrod). Other projects: "firmowid" (Firmowid).\n',
    );
    expect(projectContext(projects, null)).toBe("");
  });
});
