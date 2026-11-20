import { describe, expect, it } from "vitest";
import { visitGuests, visitPlace } from "../../lib/office/visit-guests.ts";

const visit = (extra: Record<string, unknown> = {}) => ({
  id: "v1",
  guests: 2,
  guestNames: [] as string[],
  note: "zespół z Wrocławia",
  userIds: [] as string[],
  createdBy: "staszek",
  ...extra,
});

const user = (userId: string, name: string) => ({ key: `user:${userId}`, userId, name });

describe("visitGuests", () => {
  it("names anonymous guests after the place in the note and numbers them across visits", () => {
    expect(visitGuests([visit(), visit({ id: "v2", guests: 1, note: "ludzie z Wrocławia" })], []).map((guest) => guest.name)).toEqual([
      "Gość z Wrocławia 1",
      "Gość z Wrocławia 2",
      "Gość z Wrocławia 3",
    ]);
    expect(visitGuests([visit({ guests: 1, note: "warsztaty z klientem acme" })], [])[0].name).toBe("Gość 1");
    expect(visitPlace("warsztaty z klientem")).toBeNull();
  });

  it("names a guest by their own name, never by the note", () => {
    const guests = visitGuests([visit({ guests: 3, guestNames: ["Odul"], note: "Odul i Mariusz na okres próbny" })], []);
    expect(guests.map((guest) => [guest.name, guest.named])).toEqual([
      ["Odul (gość)", true],
      ["Gość 1", false],
      ["Gość 2", false],
    ]);
  });

  it("drops a named guest who is already seated by name", () => {
    const guests = visitGuests([visit({ guestNames: ["Odul", "Mariusz"] })], [user("mariusz", "Mariusz Ciastoń")]);
    expect(guests.map((guest) => guest.name)).toEqual(["Odul (gość)"]);
  });

  it("reproduces #biuro: Mariusz says he will come while the visit counts him among two anonymous guests", () => {
    const trial = visit({
      userIds: ["staszek"],
      note: "Odul i Mariusz będą w biurze od 2026-11-19 przez dwa tygodnie próbne, pracując przy Firmowidzie.",
    });
    const present = [user("staszek", "Staszek Nowak"), user("mariusz", "Mariusz Ciastoń")];
    expect(visitGuests([trial], present).map((guest) => guest.name)).toEqual(["Gość 1"]);
  });

  it("never lets one person cancel out two guests or the visit's own people", () => {
    const present = [user("mariusz", "Mariusz Ciastoń")];
    const visits = [visit({ note: "Mariusz i ktoś" }), visit({ id: "v2", note: "Mariusz znowu" })];
    expect(visitGuests(visits, present)).toHaveLength(3);
    expect(visitGuests([visit({ note: "Mariusz i ktoś", userIds: ["mariusz"] })], present)).toHaveLength(2);
    expect(visitGuests([visit({ note: "Mariusz i ktoś", createdBy: "mariusz" })], present)).toHaveLength(2);
  });

  it("matches names regardless of case and Polish letters", () => {
    expect(visitGuests([visit({ guests: 1, guestNames: ["ZANETA"] })], [user("z", "Żaneta Kot")])).toHaveLength(0);
  });
});
