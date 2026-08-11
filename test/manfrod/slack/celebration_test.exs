defmodule Manfrod.Slack.CelebrationTest do
  use Manfrod.DataCase

  alias Manfrod.Slack.Bot
  alias Manfrod.Slack.Celebration
  alias Manfrod.Slack.EventDedup
  alias Manfrod.Slack.ThreadPermission

  @moduletag :db

  @channel "C_CELEBRATION"

  # A token that would fail loudly if any of these tests got as far as calling
  # Slack — every one of them is about *not* getting that far.
  @bot %Bot{id: "B1", token: "xoxb-invalid", team_id: "T1", user_id: "U_BOT"}

  setup do
    {:ok, thread_ts: "#{System.unique_integer([:positive])}.000100"}
  end

  describe "decide/1" do
    test "an empty thread is never worth joining" do
      assert Celebration.decide([]) == :skip
    end
  end

  describe "maybe_join/6" do
    test "a thread the bot was thrown out of stays quiet", %{thread_ts: thread_ts} do
      :ok = ThreadPermission.kick(@channel, thread_ts, %{source: "shortcut"})

      event = %{"text" => "gratulacje!", "user" => "U_HUMAN", "ts" => thread_ts}

      assert :ok =
               Celebration.maybe_join(@bot, event, @channel, thread_ts, %{id: "u1"}, @channel)

      # Being kicked is not the same as being invited — the kick must survive.
      assert ThreadPermission.kicked?(@channel, thread_ts)
    end

    test "a thread already judged in this window is not judged again", %{thread_ts: thread_ts} do
      # Stands in for an earlier reply in the same thread: the burst of
      # congratulations that follows must not cost a thread read and a model
      # call per message.
      assert EventDedup.first?({:celebration, @channel, thread_ts})

      event = %{"text" => "brawo!", "user" => "U_HUMAN", "ts" => thread_ts}

      assert :ok =
               Celebration.maybe_join(@bot, event, @channel, thread_ts, %{id: "u1"}, @channel)
    end
  end
end
