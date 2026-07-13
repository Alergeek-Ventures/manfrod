defmodule Manfrod.Memory.PendingOps do
  @moduledoc """
  ETS-backed queue of memory operations flagged by the Agent's tools, to be
  executed by the passive memory batch (Classifier) on its next flush.

  The design goal is a single writer: the Agent's mutating tools never touch
  memory directly — they only flag the message they are handling, and the
  always-on Classifier performs the actual write. This avoids duplicating the
  write logic in both the tool and the passive path.

  Keyed by `{channel_id, message_ts}` — the ts of the inbound Slack message the
  agent is handling, which is also present in the message Buffer. Two kinds of
  entries per message:

    * `:flag` — force a Classifier action for this message (e.g. the agent
      recognized an absence in a DM). The batch overrides its own LLM decision
      for that message with the flagged action, reusing the LLM-generated note
      for quality. Optional `extra` carries resolved dates / authored content.
    * `:ops` — standalone graph operations on existing nodes (escalate/delete/
      link/unlink) that the Classifier cannot derive from text; executed verbatim.

  Entries are drained (read-and-delete) by the Classifier as it processes each
  message in a batch. A periodic sweep prunes orphans left by the rare race
  where a buffer flushes before the agent flagged its message.
  """
  use GenServer

  @table :pending_ops
  @ttl_ms :timer.hours(6)
  @sweep_ms :timer.minutes(30)

  def start_link(_opts), do: GenServer.start_link(__MODULE__, [], name: __MODULE__)

  @impl true
  def init(_) do
    :ets.new(@table, [:named_table, :public, :set])
    schedule_sweep()
    {:ok, %{}}
  end

  @doc """
  Force a Classifier action for the given message. `extra` may carry
  `:start_date`/`:end_date` (absences) or `:content` (agent-authored note).
  """
  def flag_message(channel_id, ts, action, extra \\ %{})
      when is_binary(channel_id) and is_binary(ts) do
    GenServer.call(__MODULE__, {:flag, {channel_id, ts}, Map.put(extra, :action, action)})
  end

  @doc "Enqueue a standalone graph op for the batch to execute verbatim."
  def add_op(channel_id, ts, op) when is_binary(channel_id) and is_binary(ts) do
    GenServer.call(__MODULE__, {:op, {channel_id, ts}, op})
  end

  @doc """
  Atomically read and clear the flag + ops for a message.
  Returns `%{flag: map | nil, ops: [op]}`.
  """
  def take(channel_id, ts) when is_binary(channel_id) and is_binary(ts) do
    GenServer.call(__MODULE__, {:take, {channel_id, ts}})
  end

  def take(_channel_id, _ts), do: %{flag: nil, ops: []}

  # -- Server ------------------------------------------------------------------

  @impl true
  def handle_call({:flag, key, flag}, _from, state) do
    entry = fetch(key)
    store(key, %{entry | flag: flag})
    {:reply, :ok, state}
  end

  def handle_call({:op, key, op}, _from, state) do
    entry = fetch(key)
    store(key, %{entry | ops: entry.ops ++ [op]})
    {:reply, :ok, state}
  end

  def handle_call({:take, key}, _from, state) do
    entry = fetch(key)
    :ets.delete(@table, key)
    {:reply, %{flag: entry.flag, ops: entry.ops}, state}
  end

  @impl true
  def handle_info(:sweep, state) do
    now = System.monotonic_time(:millisecond)
    :ets.select_delete(@table, [{{:_, :_, :"$1"}, [{:<, :"$1", now}], [true]}])
    schedule_sweep()
    {:noreply, state}
  end

  # -- Private -----------------------------------------------------------------

  defp fetch(key) do
    case :ets.lookup(@table, key) do
      [{^key, entry, _exp}] -> entry
      [] -> %{flag: nil, ops: []}
    end
  end

  defp store(key, entry) do
    expires_at = System.monotonic_time(:millisecond) + @ttl_ms
    :ets.insert(@table, {key, entry, expires_at})
    :ok
  end

  defp schedule_sweep, do: Process.send_after(self(), :sweep, @sweep_ms)
end
