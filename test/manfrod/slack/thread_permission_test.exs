defmodule Manfrod.Slack.ThreadPermissionTest do
  use Manfrod.DataCase

  alias Manfrod.Slack.ThreadPermission

  @moduletag :db

  @channel "C_KICK"

  # Each test gets its own thread, so the process-wide ETS cache can't leak a
  # verdict from one test into the next.
  setup do
    {:ok, thread_ts: "#{System.unique_integer([:positive])}.000100"}
  end

  describe "kick/3" do
    test "marks the thread as kicked", %{thread_ts: thread_ts} do
      refute ThreadPermission.kicked?(@channel, thread_ts)

      assert :ok = ThreadPermission.kick(@channel, thread_ts, %{source: "shortcut"})

      assert ThreadPermission.kicked?(@channel, thread_ts)
    end

    test "kicking twice is a no-op rather than an error", %{thread_ts: thread_ts} do
      assert :ok = ThreadPermission.kick(@channel, thread_ts, %{source: "shortcut"})
      assert :ok = ThreadPermission.kick(@channel, thread_ts, %{source: "tool"})

      assert ThreadPermission.kicked?(@channel, thread_ts)
    end

    test "outlives the ETS cache, since the row is what makes it durable", %{
      thread_ts: thread_ts
    } do
      assert :ok = ThreadPermission.kick(@channel, thread_ts, %{source: "tool"})

      # Simulates a restart or a cache sweep: without the persisted row the
      # next re-derivation would find the old @mention and let the bot back in.
      :ets.delete(ThreadPermission, {@channel, thread_ts})

      assert ThreadPermission.kicked?(@channel, thread_ts)
    end

    test "rejects an unknown source", %{thread_ts: thread_ts} do
      assert {:error, %Ecto.Changeset{}} =
               ThreadPermission.kick(@channel, thread_ts, %{source: "telepathy"})

      refute ThreadPermission.kicked?(@channel, thread_ts)
    end
  end

  describe "allow/2" do
    test "an @mention lifts a kick", %{thread_ts: thread_ts} do
      assert :ok = ThreadPermission.kick(@channel, thread_ts, %{source: "shortcut"})
      assert ThreadPermission.kicked?(@channel, thread_ts)

      assert :ok = ThreadPermission.allow(@channel, thread_ts)

      refute ThreadPermission.kicked?(@channel, thread_ts)
    end

    test "the lift is durable too, not just a cache overwrite", %{thread_ts: thread_ts} do
      assert :ok = ThreadPermission.kick(@channel, thread_ts, %{source: "shortcut"})
      assert :ok = ThreadPermission.allow(@channel, thread_ts)

      :ets.delete(ThreadPermission, {@channel, thread_ts})

      refute ThreadPermission.kicked?(@channel, thread_ts)
    end
  end
end
