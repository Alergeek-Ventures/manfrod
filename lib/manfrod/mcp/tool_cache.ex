defmodule Manfrod.Mcp.ToolCache do
  @moduledoc """
  Short-lived cache of remote MCP `tools/list` results, keyed by
  `{user_id, provider}`.

  Tool definitions are rebuilt on every agent turn (see `Manfrod.Tools`),
  which would otherwise mean a fresh MCP `initialize` + `tools/list`
  round-trip per provider on every single message. This caches that list
  for a few minutes.
  """

  use GenServer

  @table __MODULE__
  @ttl_ms :timer.minutes(5)

  def start_link(_opts) do
    GenServer.start_link(__MODULE__, :ok, name: __MODULE__)
  end

  @doc "Returns the cached tool list, or calls `fetch_fun.()` and caches its `{:ok, tools}` result."
  def get_or_fetch(user_id, provider, fetch_fun) do
    key = {user_id, provider}
    now = System.monotonic_time(:millisecond)

    case :ets.lookup(@table, key) do
      [{^key, tools, expires_at}] when expires_at > now ->
        {:ok, tools}

      _ ->
        case fetch_fun.() do
          {:ok, tools} = ok ->
            :ets.insert(@table, {key, tools, now + @ttl_ms})
            ok

          error ->
            error
        end
    end
  end

  @doc "Drops any cached entry for `{user_id, provider}` (e.g. after a disconnect or expiry)."
  def invalidate(user_id, provider) do
    :ets.delete(@table, {user_id, provider})
  end

  @impl true
  def init(:ok) do
    :ets.new(@table, [:named_table, :public, :set, read_concurrency: true])
    {:ok, %{}}
  end
end
