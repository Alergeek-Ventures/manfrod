defmodule Manfrod.Workers.SkillSchedulerWorkerTest do
  use ExUnit.Case, async: true

  alias Manfrod.Workers.SkillSchedulerWorker

  describe "next_occurrences/2" do
    test "returns occurrences within the 12h window for a daily cron" do
      # Deliberately not on a cron boundary, to avoid ambiguity over whether
      # an exact-match "now" counts as its own next occurrence.
      now = ~U[2026-07-17 08:00:00Z]
      skill = %{name: "daily-check", cron: "0 12 * * *"}

      occurrences = SkillSchedulerWorker.next_occurrences(skill, now)

      # Europe/Warsaw is UTC+2 in July (DST) — 12:00 local == 10:00 UTC.
      # Today's firing (+2h) falls inside the 12h window; tomorrow's (+26h)
      # does not.
      assert length(occurrences) == 1
      assert Enum.all?(occurrences, &(DateTime.compare(&1, now) == :gt))

      assert Enum.all?(
               occurrences,
               &(DateTime.compare(&1, DateTime.add(now, 12, :hour)) in [:lt, :eq])
             )
    end

    test "returns an empty list for an invalid cron expression" do
      skill = %{name: "broken", cron: "not a cron"}

      assert SkillSchedulerWorker.next_occurrences(skill, DateTime.utc_now()) == []
    end

    test "returns an empty list when the next occurrence is outside the window" do
      now = ~U[2026-07-17 10:00:00Z]
      # Fires once a year on Jan 1 — far outside any 12h window.
      skill = %{name: "yearly", cron: "0 0 1 1 *"}

      assert SkillSchedulerWorker.next_occurrences(skill, now) == []
    end
  end

  describe "parse_cron/1" do
    test "parses a standard 5-field cron as :standard" do
      assert {:standard, %Crontab.CronExpression{}} =
               SkillSchedulerWorker.parse_cron("0 18 * * 0-4")
    end

    test "returns :error for an invalid standard cron" do
      assert SkillSchedulerWorker.parse_cron("not a cron") == :error
    end

    test "parses a RAND(...) fusion into start/end times and date conditions" do
      assert {:random, ~T[19:00:00], ~T[20:00:00], date_conditions} =
               SkillSchedulerWorker.parse_cron("RAND(19:00-20:00) * * 1-5")

      # Mon (2026-08-24) matches the 1-5 weekday selector...
      assert Crontab.DateChecker.matches_date?(date_conditions, ~N[2026-08-24 00:00:00])
      # ...Sunday doesn't.
      refute Crontab.DateChecker.matches_date?(date_conditions, ~N[2026-08-23 00:00:00])
    end

    test "returns :error for a malformed RAND(...) time range" do
      assert SkillSchedulerWorker.parse_cron("RAND(25:00-20:00) * * 1-5") == :error
    end

    test "returns :error when the RAND(...) day/month/weekday fields are invalid" do
      assert SkillSchedulerWorker.parse_cron("RAND(19:00-20:00) not valid fields") == :error
    end
  end
end
