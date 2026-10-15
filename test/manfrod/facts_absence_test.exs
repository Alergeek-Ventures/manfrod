defmodule Manfrod.FactsAbsenceTest do
  use Manfrod.DataCase

  alias Manfrod.Facts
  alias Manfrod.Memory.Fact

  @moduletag :db

  defp absences(user_id), do: Facts.list_facts_by_user_unscoped("absence:", user_id)

  describe "put_absence/5" do
    test "creates the absence when nothing overlaps" do
      user = insert_user!(%{name: "Ola Test"})

      assert {:ok, fact, :created} =
               Facts.put_absence(user.id, "2026-10-08", "2026-10-16", "urlop", ["internal"])

      assert fact.key == "absence:#{user.id}:2026-10-08"
      assert fact.value == "2026-10-08..2026-10-16 — urlop"
    end

    test "replaces an overlapping absence and keeps its access" do
      user = insert_user!(%{name: "Ola Test"})
      shared = ["internal", "external/all"]
      {:ok, _old, :created} = Facts.put_absence(user.id, "2026-10-08", "2026-10-16", "urlop", shared)

      assert {:ok, fact, :replaced} =
               Facts.put_absence(
                 user.id,
                 "2026-10-09",
                 "2026-10-16",
                 "pracuje poza biurem: wyjazd do klienta Scape",
                 ["internal"]
               )

      assert [^fact] = absences(user.id)
      assert fact.key == "absence:#{user.id}:2026-10-09"
      assert fact.value =~ "Scape"
      assert fact.access == shared
    end

    test "leaves absences on other dates alone" do
      user = insert_user!(%{name: "Ola Test"})
      {:ok, _, :created} = Facts.put_absence(user.id, "2026-08-01", "2026-08-05", "urlop", ["internal"])
      {:ok, _, :created} = Facts.put_absence(user.id, "2026-10-08", "2026-10-16", "urlop", ["internal"])

      assert length(absences(user.id)) == 2
    end
  end

  describe "delete_absences_ended_before/1" do
    test "deletes only absences that are over" do
      user = insert_user!(%{name: "Ola Test"})
      {:ok, past, _} = Facts.put_absence(user.id, "2026-09-01", "2026-09-05", "urlop", ["internal"])
      {:ok, current, _} = Facts.put_absence(user.id, "2026-10-01", "2026-10-20", "urlop", ["internal"])

      assert Facts.delete_absences_ended_before(~D[2026-10-10]) >= 1

      refute Repo.get(Fact, past.id)
      assert Repo.get(Fact, current.id)
    end
  end
end
