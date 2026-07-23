defmodule Manfrod.Tools.NotesTest do
  use Manfrod.DataCase

  alias Manfrod.Tools.Notes, as: NotesTool

  @moduletag :db

  @no_channel %{channel: nil, ts: nil}

  defp run(name, ctx, args) do
    tool =
      ctx
      |> NotesTool.definitions()
      |> Enum.find(&(&1.name == name))

    ReqLLM.Tool.execute(tool, args)
  end

  defp ctx(overrides \\ %{}) do
    Map.merge(
      %{
        user_id: test_user_id(),
        readable_levels: ["internal"],
        write_access: "internal",
        msg_ctx: @no_channel
      },
      overrides
    )
  end

  defp insert_node_at!(content, %DateTime{} = dt, access \\ ["internal"]) do
    naive = dt |> DateTime.to_naive() |> NaiveDateTime.truncate(:second)

    Repo.insert!(%Manfrod.Memory.Node{
      user_id: test_user_id(),
      content: content,
      access: access,
      inserted_at: naive,
      updated_at: naive
    })
  end

  describe "list_recent_notes" do
    test "lists notes newest first with a date stamp" do
      insert_node_at!("old note", ~U[2026-01-01 10:00:00Z])
      insert_node_at!("new note", ~U[2026-01-10 10:00:00Z])

      assert {:ok, msg} = run("list_recent_notes", ctx(), %{})
      assert msg =~ "2026-01-10 ["
      assert msg =~ "new note"

      new_pos = :binary.match(msg, "new note") |> elem(0)
      old_pos = :binary.match(msg, "old note") |> elem(0)
      assert new_pos < old_pos
    end

    test "filters by since/until" do
      insert_node_at!("too old", ~U[2026-01-01 10:00:00Z])
      insert_node_at!("in range", ~U[2026-01-05 10:00:00Z])
      insert_node_at!("too new", ~U[2026-01-10 10:00:00Z])

      assert {:ok, msg} =
               run("list_recent_notes", ctx(), %{since: "2026-01-03", until: "2026-01-07"})

      assert msg =~ "in range"
      refute msg =~ "too old"
      refute msg =~ "too new"
    end

    test "rejects a bad date format" do
      assert {:ok, msg} = run("list_recent_notes", ctx(), %{since: "not-a-date"})
      assert msg =~ "Invalid date"
    end

    test "supports order: asc to find the oldest notes" do
      insert_node_at!("old note", ~U[2026-01-01 10:00:00Z])
      insert_node_at!("new note", ~U[2026-01-10 10:00:00Z])

      assert {:ok, msg} = run("list_recent_notes", ctx(), %{order: "asc"})
      assert msg =~ "oldest first"
    end

    test "reports when nothing is found" do
      assert {:ok, msg} =
               run("list_recent_notes", ctx(), %{since: "2020-01-01", until: "2020-01-02"})

      assert msg =~ "No notes found"
    end

    test "only lists notes visible at the caller's access level" do
      insert_node_at!("visible", ~U[2026-01-01 10:00:00Z], ["internal"])
      insert_node_at!("hidden", ~U[2026-01-01 10:00:00Z], ["external/other"])

      assert {:ok, msg} = run("list_recent_notes", ctx(), %{})
      assert msg =~ "visible"
      refute msg =~ "hidden"
    end
  end

  describe "get_note" do
    test "includes the note's created date" do
      node = insert_node_at!("dated note", ~U[2026-01-05 10:00:00Z])

      assert {:ok, msg} = run("get_note", ctx(), %{id: node.id})
      assert msg =~ "2026-01-05"
    end
  end
end
