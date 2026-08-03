defmodule Manfrod.Slack.StreamSessionTest do
  use ExUnit.Case, async: true

  alias Manfrod.Slack.StreamSession

  describe "remaining_text/2" do
    test "appends nothing when the stream already showed the whole answer" do
      answer = "Zarezerwowałem biurko A1 na jutro."

      assert StreamSession.remaining_text(answer, answer) == ""
    end

    test "ignores whitespace the provider added or dropped at the edges" do
      assert StreamSession.remaining_text("Gotowe.\n", "Gotowe.") == ""
      assert StreamSession.remaining_text("Gotowe.", "  Gotowe.  ") == ""
    end

    test "sends the tail when the last fragment did not make it into the stream" do
      assert StreamSession.remaining_text("Biurko A1 ", "Biurko A1 jest wolne.") ==
               "jest wolne."
    end

    test "sends everything when nothing was streamed" do
      assert StreamSession.remaining_text("", "Cała odpowiedź.") == "Cała odpowiedź."
      assert StreamSession.remaining_text("   ", "Cała odpowiedź.") == "Cała odpowiedź."
    end

    # The agent replaces the answer wholesale on some paths (an LLM error, the
    # blank-response "👍" fallback). Repeating a sentence is recoverable;
    # silently dropping the actual answer is not.
    test "appends the whole answer when it diverges from what was streamed" do
      assert StreamSession.remaining_text(
               "Sprawdzam kalendarz",
               "Sorry, I encountered an error: :timeout"
             ) == "\n\nSorry, I encountered an error: :timeout"
    end
  end
end
