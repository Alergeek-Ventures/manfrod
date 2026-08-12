defmodule Manfrod.Slack.EventDedup do
  @moduledoc """
  ETS-based once-only guard for inbound Slack events.

  Slack delivers a channel @mention as two separate events — a `message` and
  an `app_mention` — and Socket Mode may additionally redeliver an event on a
  missed ack. Without a guard each delivery reaches the Agent and the bot
  replies twice to one message. `first?/1` returns true exactly once per key
  (message identity, e.g. `{:mention, channel, ts}`); every later call within
  the TTL window returns false.

  Entries expire after #{5} minutes via a periodic sweep — long past Slack's
  redelivery window, small enough that the table stays tiny.
  """

  use GenServer

  @table __MODULE__
  @ttl_ms :timer.minutes(5)
  @sweep_interval_ms :timer.minutes(1)

  def start_link(_opts) do
    GenServer.start_link(__MODULE__, nil, name: __MODULE__)
  end

  @doc """
  Register `key` as seen. Returns true only for the first call with this key
  within the TTL window.
  """
  @spec first?(term()) :: boolean()
  def first?(key) do
    :ets.insert_new(@table, {key, System.monotonic_time(:millisecond)})
  end

  @impl true
  def init(nil) do
    :ets.new(@table, [:named_table, :public, :set, write_concurrency: true])
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
