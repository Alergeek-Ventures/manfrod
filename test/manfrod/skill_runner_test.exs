defmodule Manfrod.SkillRunnerTest do
  use ExUnit.Case, async: true

  alias Manfrod.SkillRunner

  describe "empty_reply?/1" do
    test "matches the exact EMPTY sentinel" do
      assert SkillRunner.empty_reply?("EMPTY")
    end

    test "matches EMPTY with surrounding whitespace/newlines" do
      assert SkillRunner.empty_reply?("  EMPTY\n")
    end

    test "does not match normal reply text" do
      refute SkillRunner.empty_reply?("Sprawdziłem święta na najbliższy tydzień.")
    end

    test "does not match text that merely contains EMPTY" do
      refute SkillRunner.empty_reply?("EMPTY is the answer")
    end

    test "does not match an empty string (handled separately)" do
      refute SkillRunner.empty_reply?("")
    end
  end
end
