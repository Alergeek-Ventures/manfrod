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

    test "matches EMPTY appearing anywhere in a longer reply" do
      assert SkillRunner.empty_reply?(
               "Now: 2026-07-31T12:44:31+02:00 (Friday). Schedule is Sun-Thu only, so no digest fires today.\n\nEMPTY"
             )
    end

    test "does not match lowercase or mixed-case empty" do
      refute SkillRunner.empty_reply?("empty")
      refute SkillRunner.empty_reply?("Empty")
      refute SkillRunner.empty_reply?("The result set is empty.")
    end

    test "does not match EMPTY as part of a larger word" do
      refute SkillRunner.empty_reply?("PREEMPTYIVE")
    end

    test "does not match an empty string (handled separately)" do
      refute SkillRunner.empty_reply?("")
    end
  end
end
