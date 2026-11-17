import { describe, expect, it } from "vitest";
import { deskLine } from "../../agent/lib/office.ts";
import type { Desk } from "../../lib/db/schema.ts";

function makeDesk(overrides: Partial<Desk> = {}): Desk {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    label: "A1",
    locationNote: null,
    equipment: [],
    mapX: null,
    mapY: null,
    permanentOwner: null,
    active: true,
    insertedAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("deskLine", () => {
  it("marks a desk without reservation as free", () => {
    expect(deskLine(makeDesk(), undefined)).toBe("- A1 [brak sprzętu] — wolne");
  });

  it("shows the reserving user's name", () => {
    expect(deskLine(makeDesk(), { user: { name: "Name" } })).toContain("— zajęte: Name");
  });

  it("does not show a reserved desk as free when the user has no name", () => {
    const line = deskLine(makeDesk(), { user: { name: null } });
    expect(line).not.toContain("wolne");
    expect(line).toContain("zajęte");
  });

  it("does not show a desk with an empty permanent owner as free", () => {
    const line = deskLine(makeDesk({ permanentOwner: "" }), undefined);
    expect(line).not.toContain("wolne");
    expect(line).toContain("na stałe");
  });

  it("shows the permanent owner", () => {
    expect(deskLine(makeDesk({ permanentOwner: "Ala" }), undefined)).toContain("— na stałe: Ala");
  });
});
