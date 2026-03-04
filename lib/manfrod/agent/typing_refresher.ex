defmodule Manfrod.Agent.TypingRefresher do
  @moduledoc """
  Relays LLM retry/fallback events as :thinking events to keep activity indicators alive.

  During long LLM operations with retries and fallbacks, this process listens for
  LLM events and re-broadcasts :thinking to signal that processing is still active.
  Transport adapters (e.g. Slack) can subscribe to these events to refresh their
  own typing/processing indicators.

  ## Usage

      {:ok, pid} = TypingRefresher.start(user_id, event_ctx)
      result = LLM.generate_text(messages, opts)
      TypingRefresher.stop(pid)
  """

  alias Manfrod.Events

  @llm_events [:llm_call_started, :llm_retry, :llm_fallback]

  @doc """
  Start a typing refresher process for the given user and event context.

  The process subscribes to the user's PubSub topic and relays LLM events
  as :thinking events to trigger typing indicator refresh.
  """
  def start(user_id, event_ctx) do
    parent = self()
    pid = spawn_link(fn -> run(user_id, event_ctx, parent) end)

    receive do
      {:subscribed, ^pid} -> {:ok, pid}
    after
      1_000 -> {:error, :subscription_timeout}
    end
  end

  @doc """
  Stop the typing refresher process.
  """
  def stop(pid) when is_pid(pid) do
    send(pid, :stop)
    :ok
  end

  defp run(user_id, event_ctx, parent) do
    Events.subscribe(user_id)
    send(parent, {:subscribed, self()})
    loop(event_ctx)
  end

  defp loop(event_ctx) do
    receive do
      :stop ->
        :ok

      {:activity, %{type: type}} when type in @llm_events ->
        Events.broadcast(:thinking, event_ctx)
        loop(event_ctx)

      _other ->
        loop(event_ctx)
    end
  end
end
