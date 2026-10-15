defmodule Manfrod.Agent.ServerTurnTest do
  use ExUnit.Case, async: false

  alias Manfrod.Agent.Server

  defp ctx(user_id, opts \\ []) do
    %{
      user_id: user_id,
      readable_levels: ["internal"],
      requires_gate: Keyword.get(opts, :requires_gate, false),
      session_key: "C1:1.0",
      meta: %{write_access: ["internal"], slack_channel_id: "C1"},
      source: :slack,
      reply_to: %{channel: "C1", thread_ts: "1.0", slack_user_id: "U_#{user_id}"},
      slack_ts: "2.0"
    }
  end

  defp state(overrides) do
    Map.merge(
      %{
        user_id: "alice",
        session_key: "C1:1.0",
        write_access: ["internal"],
        readable_levels: ["internal"],
        participants: MapSet.new(["alice"]),
        unextracted: MapSet.new(),
        messages: [],
        prompt_built_at: System.monotonic_time(:millisecond),
        transcript: [],
        inbox: [],
        turn: nil,
        owed: false,
        turn_tools: nil,
        turn_notes: [],
        last_ctx: nil,
        flush_timer: nil,
        shutdown_timer: nil,
        gate_debounce_timer: nil,
        last_user_content: nil
      },
      overrides
    )
  end

  describe ":loop" do
    test "waits while a turn is running instead of starting a second one" do
      state = state(%{turn: "alice", inbox: [{"hej", ctx("bob")}]})

      assert {:noreply, ^state} = Server.handle_info(:loop, state)
    end

    test "lets a plain reply's debounce finish before judging it" do
      timer = make_ref()

      state =
        state(%{inbox: [{"hej", ctx("bob", requires_gate: true)}], gate_debounce_timer: timer})

      assert {:noreply, ^state} = Server.handle_info(:loop, state)
    end
  end

  describe "{:call_llm, ...} interrupt" do
    test "the author's own follow-up restarts the turn and owes it an answer" do
      state = state(%{turn: "alice", inbox: [{"a jeszcze to", ctx("alice", requires_gate: true)}]})

      assert {:noreply, new_state} = Server.handle_info({:call_llm, ctx("alice"), 2, nil}, state)

      assert new_state.turn == nil
      assert new_state.owed
      assert_received :loop
    end
  end

  describe "idle timers" do
    test "a short idle hands messages to extraction but keeps the session" do
      assert {:noreply, new_state} = Server.handle_info({:flush, ctx("alice")}, state(%{}))

      assert new_state.flush_timer == nil
      assert new_state.unextracted == MapSet.new()
    end

    test "a long idle stops the session" do
      assert {:stop, :normal, _state} = Server.handle_info(:shutdown_idle, state(%{}))
    end

    test "a long idle does not stop the session in the middle of a turn" do
      assert {:noreply, new_state} = Server.handle_info(:shutdown_idle, state(%{turn: "alice"}))

      assert is_reference(new_state.shutdown_timer)
      Process.cancel_timer(new_state.shutdown_timer)
    end
  end

  describe "{:flush, ...}" do
    test "does not end the session in the middle of a turn" do
      state = state(%{turn: "alice"})

      assert {:noreply, new_state} = Server.handle_info({:flush, ctx("alice")}, state)

      assert is_reference(new_state.flush_timer)
      Process.cancel_timer(new_state.flush_timer)
    end

    test "does not end the session while messages wait in the inbox" do
      state = state(%{inbox: [{"hej", ctx("bob", requires_gate: true)}]})

      assert {:noreply, new_state} = Server.handle_info({:flush, ctx("bob")}, state)

      assert is_reference(new_state.flush_timer)
      Process.cancel_timer(new_state.flush_timer)
    end
  end
end
