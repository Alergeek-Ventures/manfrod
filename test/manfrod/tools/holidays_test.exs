defmodule Manfrod.Tools.HolidaysTest do
  use Manfrod.DataCase

  alias Manfrod.Facts
  alias Manfrod.Tools.Holidays, as: HolidaysTool

  @moduletag :db

  @readable_levels ["internal"]

  defp run(name, user_id, args) do
    tool =
      %{user_id: user_id, readable_levels: @readable_levels}
      |> HolidaysTool.definitions()
      |> Enum.find(&(&1.name == name))

    ReqLLM.Tool.execute(tool, args)
  end

  describe "check_holiday_plan/2" do
    test "needs_ask when nothing is recorded for the user" do
      user = insert_user!()

      assert {:ok, msg} =
               run("check_holiday_plan", user.id, %{user_id: user.id, date: "2026-08-15"})

      assert msg =~ "needs_ask"
    end

    test "resolved when an absence fact (set by this user) covers the date" do
      user = insert_user!()

      {:ok, _} =
        Facts.set_fact(
          "absence:#{user.name}:2026-08-14",
          "2026-08-14..2026-08-16 — \"biorę urlop\"",
          ["internal"],
          user.id
        )

      assert {:ok, msg} =
               run("check_holiday_plan", user.id, %{user_id: user.id, date: "2026-08-15"})

      assert msg =~ "resolved"
    end

    test "does not match an absence fact set by a different user" do
      user = insert_user!()
      other = insert_user!()

      {:ok, _} =
        Facts.set_fact(
          "absence:#{other.name}:2026-08-14",
          "2026-08-14..2026-08-16 — \"biorę urlop\"",
          ["internal"],
          other.id
        )

      assert {:ok, msg} =
               run("check_holiday_plan", user.id, %{user_id: user.id, date: "2026-08-15"})

      assert msg =~ "needs_ask"
    end

    test "resolved when the user already confirmed they're working" do
      user = insert_user!()
      {:ok, _} = run("record_holiday_plan", user.id, %{date: "2026-08-15", status: "working"})

      assert {:ok, msg} =
               run("check_holiday_plan", user.id, %{user_id: user.id, date: "2026-08-15"})

      assert msg =~ "resolved"
      assert msg =~ "working"
    end

    test "snoozed right after an 'unsure' answer, needs_ask again once the snooze expires" do
      user = insert_user!()

      {:ok, _} =
        run("record_holiday_plan", user.id, %{
          date: "2026-08-15",
          status: "unsure",
          recheck_in_days: 2
        })

      assert {:ok, msg} =
               run("check_holiday_plan", user.id, %{user_id: user.id, date: "2026-08-15"})

      assert msg =~ "snoozed"

      key = "holiday-plan:#{user.id}:2026-08-15"
      past = Date.utc_today() |> Date.add(-1) |> Date.to_iso8601()
      {:ok, _} = Facts.set_fact(key, "unsure:#{past}", ["internal"], user.id)

      assert {:ok, msg} =
               run("check_holiday_plan", user.id, %{user_id: user.id, date: "2026-08-15"})

      assert msg =~ "needs_ask"
    end

    test "invalid date is reported without crashing" do
      user = insert_user!()

      assert {:ok, msg} =
               run("check_holiday_plan", user.id, %{user_id: user.id, date: "not-a-date"})

      assert msg =~ "Invalid date"
    end
  end

  describe "ask_user_about_holiday/2" do
    test "is a no-op when the user already has an absence covering the date" do
      user = insert_user!()

      {:ok, _} =
        Facts.set_fact(
          "absence:#{user.name}:2026-08-15",
          "2026-08-15..2026-08-15 — \"biorę urlop\"",
          ["internal"],
          user.id
        )

      assert {:ok, msg} =
               run("ask_user_about_holiday", user.id, %{
                 user_id: user.id,
                 date: "2026-08-15",
                 holiday_name: "Testowe święto"
               })

      assert msg =~ "Pomijam"
      refute msg =~ "Wysłano"
    end

    test "is a no-op when the user already confirmed they're working" do
      user = insert_user!()
      {:ok, _} = run("record_holiday_plan", user.id, %{date: "2026-08-15", status: "working"})

      assert {:ok, msg} =
               run("ask_user_about_holiday", user.id, %{
                 user_id: user.id,
                 date: "2026-08-15",
                 holiday_name: "Testowe święto"
               })

      assert msg =~ "Pomijam"
      refute msg =~ "Wysłano"
    end
  end

  describe "list_team_members/0" do
    test "excludes system users" do
      user = insert_user!()
      insert_user!(%{slack_id: "system:test-fixture", name: "System Fixture"})

      assert {:ok, msg} = run("list_team_members", user.id, %{})
      assert msg =~ user.id
      refute msg =~ "System Fixture"
    end
  end
end
