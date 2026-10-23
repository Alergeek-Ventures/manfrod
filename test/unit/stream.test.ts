import { describe, expect, it } from "vitest";
import { remainingText } from "../../lib/slack/stream.ts";

describe("remainingText", () => {
  it("appends nothing when the stream already showed the whole answer", () => {
    const answer = "Zarezerwowałem biurko A1 na jutro.";
    expect(remainingText(answer, answer)).toBe("");
  });

  it("ignores whitespace at the edges", () => {
    expect(remainingText("Gotowe.\n", "Gotowe.")).toBe("");
    expect(remainingText("Gotowe.", "  Gotowe.  ")).toBe("");
  });

  it("sends the tail that did not make it into the stream", () => {
    expect(remainingText("Biurko A1 ", "Biurko A1 jest wolne.")).toBe("jest wolne.");
  });

  it("sends everything when nothing was streamed", () => {
    expect(remainingText("", "Cała odpowiedź.")).toBe("Cała odpowiedź.");
    expect(remainingText("   ", "Cała odpowiedź.")).toBe("Cała odpowiedź.");
  });

  it("appends the whole answer when it diverges", () => {
    expect(remainingText("Sprawdzam kalendarz", "Sorry, I encountered an error: :timeout")).toBe(
      "\n\nSorry, I encountered an error: :timeout",
    );
  });
});
