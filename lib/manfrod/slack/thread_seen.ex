defmodule Manfrod.Slack.ThreadSeen do
  @moduledoc """
  Which messages of a channel thread the agent's session already has in its
  context.

  A thread session only receives what is routed to it: @mentions and plain
  replies from known users once the bot is invited. Anything else — messages
  from people who never DMed the bot, replies posted before a re-mention —
  never reaches it. When the bot is @mentioned, `Manfrod.Slack.EventHandler`
  compares the thread against this record and hands the session only what it
  has not seen, instead of re-sending the whole thread every time.

  Kept in ETS for as long as a channel session restores its history from the
  DB (`Manfrod.Agent.Server`, 24 hours); past that the thread is caught up
  from scratch, which is exactly what the restored context lacks by then.
  """

  use GenServer

  @table __MODULE__
  @ttl_ms :timer.hours(24)
  @sweep_interval_ms :timer.minutes(10)

  def start_link(_opts) do
    GenServer.start_link(__MODULE__, nil, name: __MODULE__)
  end

  @doc "Record that the session for `session_key` has these messages in context."
  @spec mark(String.t(), [String.t()]) :: :ok
  def mark(session_key, ts_list) do
    now = System.monotonic_time(:millisecond)
    :ets.insert(@table, Enum.map(ts_list, &{{session_key, &1}, now}))
    :ok
  rescue
    ArgumentError -> :ok
  end

  @doc "Every message ts the session for `session_key` has in context."
  @spec seen(String.t()) :: MapSet.t(String.t())
  def seen(session_key) do
    @table
    |> :ets.select([{{{session_key, :"$1"}, :_}, [], [:"$1"]}])
    |> MapSet.new()
  rescue
    ArgumentError -> MapSet.new()
  end

  @impl true
  def init(nil) do
    :ets.new(@table, [:named_table, :public, :ordered_set, write_concurrency: true])
    schedule_sweep()
    {:ok, nil}
  end

  @impl true
  def handle_info(:sweep, state) do
    cutoff = System.monotonic_time(:millisecond) - @ttl_ms
    :ets.select_delete(@table, [{{:_, :"$1"}, [{:<, :"$1", cutoff}], [true]}])
    schedule_sweep()
    {:noreply, state}
  end

  defp schedule_sweep do
    Process.send_after(self(), :sweep, @sweep_interval_ms)
  end
end
