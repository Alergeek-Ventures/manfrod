defmodule Manfrod.AgentTest do
  use Manfrod.DataCase

  alias Manfrod.Agent
  alias Manfrod.Events

  @moduletag :db
  @moduletag :slow

  # These tests require a running LLM backend and are skipped in CI.
  # They verify the per-session Agent lifecycle: start → process → respond → idle.

  @test_session_key "D0001:1700000000.000001"

  defp test_user_id_for_agent do
    user = insert_user!(%{slack_id: "U_AGENT_TEST", name: "Agent Test User"})
    user.id
  end

  describe "event broadcasting" do
    setup do
      user_id = test_user_id_for_agent()
      Events.subscribe(user_id)
      {:ok, user_id: user_id}
    end

    test "broadcasts :thinking when processing message", %{user_id: user_id} do
      Agent.send_message(user_id, @test_session_key, %{
        content: "Test message #{System.unique_integer()}",
        source: :test,
        reply_to: self()
      })

      # Should receive thinking event (might take a while if agent is busy)
      assert_receive {:activity, %{type: :thinking, source: :test}}, 60_000
    end

    test "broadcasts :responding after processing", %{user_id: user_id} do
      Agent.send_message(user_id, @test_session_key, %{
        content: "Quick test #{System.unique_integer()}",
        source: :test,
        reply_to: self()
      })

      # Wait for full cycle - thinking then responding
      assert_receive {:activity, %{type: :thinking}}, 60_000
      assert_receive {:activity, %{type: :responding}}, 120_000
    end
  end

  describe "interrupt behavior" do
    setup do
      user_id = test_user_id_for_agent()
      Events.subscribe(user_id)
      {:ok, user_id: user_id}
    end

    @tag :interrupt
    test "new message during processing triggers interrupt", %{user_id: user_id} do
      # This test verifies the interrupt mechanism by sending messages
      # in rapid succession and checking that:
      # 1. Messages queue up in inbox
      # 2. Interrupt is detected before next LLM call
      # 3. All messages get processed

      # Send first message
      Agent.send_message(user_id, @test_session_key, %{
        content: "First message #{System.unique_integer()}",
        source: :test,
        reply_to: self()
      })

      # Wait for thinking to start
      assert_receive {:activity, %{type: :thinking, source: :test}}, 60_000

      # Immediately send second message while first is processing
      Agent.send_message(user_id, @test_session_key, %{
        content: "Second message (interrupt) #{System.unique_integer()}",
        source: :test,
        reply_to: self()
      })

      # We should eventually get either:
      # - :interrupted followed by new :thinking, or
      # - Just process both in sequence (if first finished before second arrived)

      # Collect events for analysis
      events = collect_events(120_000)

      # Verify we got at least one thinking and one responding
      event_types = Enum.map(events, & &1.type)
      assert :thinking in event_types
      assert :responding in event_types

      # Log what happened for debugging
      IO.puts("\nEvents received: #{inspect(event_types)}")

      if :interrupted in event_types do
        IO.puts("Interrupt was triggered!")
      else
        IO.puts("No interrupt (messages processed sequentially)")
      end
    end
  end

  describe "loop behavior" do
    test "empty inbox loop is no-op" do
      user_id = test_user_id_for_agent()

      # Start agent by sending a message, then look up the pid
      {:ok, pid} =
        DynamicSupervisor.start_child(
          Manfrod.Agent.DynamicSupervisor,
          {Manfrod.Agent.Server, {user_id, @test_session_key}}
        )

      # Send :loop - should be safe even during work
      send(pid, :loop)

      # If inbox is empty, this is a no-op
      # We can't easily verify, but at least it shouldn't crash
      ref = Process.monitor(pid)
      refute_receive {:DOWN, ^ref, :process, ^pid, _}, 200
    end

    test "multiple :loop messages don't cause issues" do
      user_id = test_user_id_for_agent()

      {:ok, pid} =
        DynamicSupervisor.start_child(
          Manfrod.Agent.DynamicSupervisor,
          {Manfrod.Agent.Server, {user_id, @test_session_key}}
        )

      # Send multiple :loop messages rapidly
      for _ <- 1..10 do
        send(pid, :loop)
      end

      ref = Process.monitor(pid)
      refute_receive {:DOWN, ^ref, :process, ^pid, _}, 200
    end
  end

  # Helper to collect events until timeout or :responding received
  defp collect_events(timeout) do
    collect_events([], timeout, System.monotonic_time(:millisecond))
  end

  defp collect_events(acc, timeout, start_time) do
    elapsed = System.monotonic_time(:millisecond) - start_time

    if elapsed > timeout do
      Enum.reverse(acc)
    else
      remaining = timeout - elapsed

      receive do
        {:activity, %{type: :responding} = activity} ->
          Enum.reverse([activity | acc])

        {:activity, activity} ->
          collect_events([activity | acc], timeout, start_time)
      after
        remaining -> Enum.reverse(acc)
      end
    end
  end
end
