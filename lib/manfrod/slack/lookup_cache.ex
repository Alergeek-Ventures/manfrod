defmodule Manfrod.Slack.LookupCache do
  @moduledoc """
  Short-lived cache for the Slack lookups every inbound message repeats —
  `users.info` and `conversations.info` — so a busy thread does not spend
  several Web API calls per message asking for the same names again.

  Only successful lookups are kept. Without the table (Slack integration
  disabled, tests) every call goes straight to Slack.
  """

  use GenServer

  @table __MODULE__
  @ttl_ms :timer.hours(1)
  @sweep_interval_ms :timer.minutes(10)

  def start_link(_opts) do
    GenServer.start_link(__MODULE__, nil, name: __MODULE__)
  end

  @doc """
  Return the cached value for `key`, or call `fun` and cache its result when
  it is `{:ok, value}`. Anything else is returned as is and not cached.
  """
  @spec fetch(term(), (-> {:ok, term()} | term())) :: {:ok, term()} | term()
  def fetch(key, fun) do
    case lookup(key) do
      {:ok, value} ->
        {:ok, value}

      :miss ->
        case fun.() do
          {:ok, value} ->
            put(key, value)
            {:ok, value}

          other ->
            other
        end
    end
  end

  defp lookup(key) do
    case :ets.lookup(@table, key) do
      [{^key, value, inserted_at}] ->
        if System.monotonic_time(:millisecond) - inserted_at < @ttl_ms,
          do: {:ok, value},
          else: :miss

      [] ->
        :miss
    end
  rescue
    ArgumentError -> :miss
  end

  defp put(key, value) do
    :ets.insert(@table, {key, value, System.monotonic_time(:millisecond)})
  rescue
    ArgumentError -> true
  end

  @impl true
  def init(nil) do
    :ets.new(@table, [:named_table, :public, :set, read_concurrency: true])
    schedule_sweep()
    {:ok, nil}
  end

  @impl true
  def handle_info(:sweep, state) do
    cutoff = System.monotonic_time(:millisecond) - @ttl_ms
    :ets.select_delete(@table, [{{:_, :_, :"$1"}, [{:<, :"$1", cutoff}], [true]}])
    schedule_sweep()
    {:noreply, state}
  end

  defp schedule_sweep do
    Process.send_after(self(), :sweep, @sweep_interval_ms)
  end
end
