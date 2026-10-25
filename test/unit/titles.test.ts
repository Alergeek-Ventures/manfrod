import { describe, expect, it } from "vitest";
import { cleanTitle } from "../../lib/agent/titles.ts";

describe("cleanTitle", () => {
  it("keeps a plain title", () => {
    expect(cleanTitle('"Wygasłe połączenie z Firmowid"')).toBe("Wygasłe połączenie z Firmowid");
  });

  it("drops reasoning the model put before the title", () => {
    const raw =
      'Polish message. Title under 60 chars, matching language. Something like "Wygasłe połączenie z Firmowid i rezerwacja T1" — about 45 chars.\n\nWygasłe połączenie z Firmowid i rezerwacja T1';
    expect(cleanTitle(raw)).toBe("Wygasłe połączenie z Firmowid i rezerwacja T1");
  });

  it("rejects an answer that is too long to be a title", () => {
    expect(cleanTitle("This is a whole sentence explaining what the title should be rather than a title")).toBeNull();
  });
});
