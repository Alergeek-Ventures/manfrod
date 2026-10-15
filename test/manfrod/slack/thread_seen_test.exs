defmodule Manfrod.Slack.ThreadSeenTest do
  use ExUnit.Case, async: false

  alias Manfrod.Slack.ThreadSeen

  setup do
    unless Process.whereis(ThreadSeen), do: start_supervised!(ThreadSeen)

    %{session_key: "C1:#{System.unique_integer([:positive])}.000100"}
  end

  test "remembers what a session has seen", %{session_key: session_key} do
    assert ThreadSeen.seen(session_key) == MapSet.new()

    ThreadSeen.mark(session_key, ["1.1", "1.2"])
    ThreadSeen.mark(session_key, ["1.2", "1.3"])

    assert ThreadSeen.seen(session_key) == MapSet.new(["1.1", "1.2", "1.3"])
  end

  test "keeps sessions apart", %{session_key: session_key} do
    other = session_key <> "9"

    ThreadSeen.mark(session_key, ["1.1"])
    ThreadSeen.mark(other, ["2.1"])

    assert ThreadSeen.seen(session_key) == MapSet.new(["1.1"])
    assert ThreadSeen.seen(other) == MapSet.new(["2.1"])
  end
end
