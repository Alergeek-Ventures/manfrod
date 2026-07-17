defmodule Manfrod.SkillsTest do
  use ExUnit.Case, async: true

  alias Manfrod.Skills

  describe "list/0" do
    test "discovers the vacation-tracking skill" do
      names = Skills.list() |> Enum.map(& &1.name)

      assert "vacation-tracking" in names
    end

    test "returns a non-empty description for every discovered skill" do
      for skill <- Skills.list() do
        assert is_binary(skill.description)
        assert skill.description != ""
      end
    end

    test "leaves cron nil for skills without a cron field" do
      skill = Skills.list() |> Enum.find(&(&1.name == "vacation-tracking"))

      assert skill.cron == nil
    end
  end

  describe "cron skills (fixture dir)" do
    setup do
      fixture_dir = Path.expand("../support/fixtures/skills", __DIR__)
      Application.put_env(:manfrod, :skills_dir, fixture_dir)
      on_exit(fn -> Application.delete_env(:manfrod, :skills_dir) end)
      :ok
    end

    test "captures a skill's cron field with surrounding quotes stripped" do
      skill = Skills.list() |> Enum.find(&(&1.name == "cron-sample"))

      assert skill.cron == "0 0 * * 0"
    end

    test "list_cron_skills/0 includes only skills with a cron field" do
      names = Skills.list_cron_skills() |> Enum.map(& &1.name)

      assert "cron-sample" in names
      refute "plain-sample" in names
    end
  end

  describe "catalog_text/0" do
    test "includes every skill's name and description" do
      text = Skills.catalog_text()

      assert text =~ "vacation-tracking"
      assert text =~ "Available Skills"
    end
  end

  describe "get_body/1" do
    test "returns the full body for a known skill" do
      assert {:ok, body} = Skills.get_body("vacation-tracking")
      assert body =~ "report_vacation"
      assert body =~ "list_facts"
      refute body =~ "---"
    end

    test "returns not_found for an unknown skill" do
      assert {:error, :not_found} = Skills.get_body("does-not-exist")
    end
  end

  describe "read_prompt/1" do
    test "reads a plain prompt file with no frontmatter parsing" do
      content = Skills.read_prompt("memory/classifier.md")

      assert content =~ "memory decision classifier"
    end
  end
end
