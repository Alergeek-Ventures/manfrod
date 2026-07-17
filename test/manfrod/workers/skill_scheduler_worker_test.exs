defmodule Manfrod.Workers.SkillSchedulerWorkerTest do
  use ExUnit.Case, async: true

  alias Manfrod.Workers.SkillSchedulerWorker

  describe "next_occurrences/2" do
    test "returns occurrences within the 48h window for a daily cron" do
      # Deliberately not on a cron boundary, to avoid ambiguity over whether
      # an exact-match "now" counts as its own next occurrence.
      now = ~U[2026-07-17 10:30:00Z]
      skill = %{name: "daily-check", cron: "0 12 * * *"}

      occurrences = SkillSchedulerWorker.next_occurrences(skill, now)

      # Europe/Warsaw is UTC+2 in July (DST) — 12:00 local == 10:00 UTC.
      # Next two firings (tomorrow, day after) fall inside the 48h window;
      # the third (+71.5h) does not.
      assert length(occurrences) == 2
      assert Enum.all?(occurrences, &(DateTime.compare(&1, now) == :gt))

      assert Enum.all?(
               occurrences,
               &(DateTime.compare(&1, DateTime.add(now, 48, :hour)) in [:lt, :eq])
             )
    end

    test "returns an empty list for an invalid cron expression" do
      skill = %{name: "broken", cron: "not a cron"}

      assert SkillSchedulerWorker.next_occurrences(skill, DateTime.utc_now()) == []
    end

    test "returns an empty list when the next occurrence is outside the window" do
      now = ~U[2026-07-17 10:00:00Z]
      # Fires once a year on Jan 1 — far outside any 48h window.
      skill = %{name: "yearly", cron: "0 0 1 1 *"}

      assert SkillSchedulerWorker.next_occurrences(skill, now) == []
    end
  end
end
