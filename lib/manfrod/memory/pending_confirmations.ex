defmodule Manfrod.Memory.PendingConfirmations do
  @moduledoc """
  ETS-based store for ask_human pending escalation confirmations.

  The node is already saved at the channel's default access level when the
  confirmation is created — the pending entry only tracks the proposed
  escalation. Keyed by the bot's question message ts:

  - Accept button → node access widened to the target level, entry deleted.
  - Deny button → entry deleted, node stays at default access.
  - Timeout (TTL) → entry pruned, node stays at default access.

  Nothing is ever lost on deny/timeout — the note exists from the start.
  """
  use GenServer

  @table :pending_confirmations
  @ttl_ms :timer.hours(24)

  def start_link(_opts), do: GenServer.start_link(__MODULE__, [], name: __MODULE__)

  @impl true
  def init(_) do
    :ets.new(@table, [:named_table, :public, :set])
    {:ok, %{}}
  end

  def put(bot_ts, channel_id, payload) do
    expires_at = System.monotonic_time(:millisecond) + @ttl_ms
    :ets.insert(@table, {bot_ts, channel_id, payload, expires_at})
    :ok
  end

  def get(bot_ts) do
    now = System.monotonic_time(:millisecond)

    case :ets.lookup(@table, bot_ts) do
      [{^bot_ts, channel_id, payload, expires_at}] when expires_at > now ->
        {:ok, channel_id, payload}

      [{^bot_ts, _, _, _}] ->
        :ets.delete(@table, bot_ts)
        :not_found

      [] ->
        :not_found
    end
  end

  def delete(bot_ts) do
    :ets.delete(@table, bot_ts)
    :ok
  end
end
