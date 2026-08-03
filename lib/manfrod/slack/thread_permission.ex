defmodule Manfrod.Slack.ThreadPermission do
  @moduledoc """
  Decides whether the bot is allowed to speak in a public channel thread.

  The rule: the bot never speaks in a channel thread on its own. It may only
  reply there once it has been @mentioned in that thread — either in the
  thread's root message or in any later reply. From that point on the whole
  thread is "invited" and plain replies can be answered (still subject to
  `Manfrod.Agent.ResponseGate`).

  Permission is a property of the *thread*, not of a live Agent process:
  sessions terminate on idle timeout, and a proactive/cron message can create
  a session in a thread nobody ever invited the bot into. Basing the decision
  on process liveness therefore both lost permission (thread went quiet for a
  while) and granted it where it was never given.

  Verdicts are cached in ETS; on a miss the thread is fetched from Slack
  (`conversations.replies`) and scanned for a real `<@bot_id>` mention, so
  permission survives restarts and is re-derivable from Slack itself — the
  source of truth. `allow/2` records permission immediately when a mention
  arrives, so no API round-trip is needed in the common case.
  """

  use GenServer

  require Logger

  alias Manfrod.Slack.API

  @table __MODULE__
  # Allowed verdicts are re-derived from Slack once a day, denied ones every
  # few minutes — a mention arriving in the meantime overwrites the entry via
  # allow/2 anyway, so a stale "denied" can only linger if the mention was
  # missed entirely (e.g. the app was down when it arrived).
  @allowed_ttl_ms :timer.hours(24)
  @denied_ttl_ms :timer.minutes(5)
  @sweep_interval_ms :timer.minutes(10)
  @thread_scan_limit 200

  def start_link(_opts) do
    GenServer.start_link(__MODULE__, nil, name: __MODULE__)
  end

  @doc """
  Record that the bot was @mentioned in this thread — it may speak here from
  now on.
  """
  @spec allow(String.t(), String.t()) :: :ok
  def allow(channel, thread_ts) do
    put(key(channel, thread_ts), :allowed)
    :ok
  end

  @doc """
  Whether the bot may reply in this channel thread.

  Falls back to a Slack lookup on a cache miss. On an API failure the answer
  is `false` — staying silent in a thread we were possibly never invited into
  is the safe failure mode.
  """
  @spec allowed?(Manfrod.Slack.Bot.t(), String.t(), String.t()) :: boolean()
  def allowed?(bot, channel, thread_ts) do
    case lookup(key(channel, thread_ts)) do
      {:ok, verdict} ->
        verdict == :allowed

      :miss ->
        verdict = if mentioned_in_thread?(bot, channel, thread_ts), do: :allowed, else: :denied
        put(key(channel, thread_ts), verdict)
        verdict == :allowed
    end
  end

  defp mentioned_in_thread?(bot, channel, thread_ts) do
    case API.list_thread_replies(bot.token, channel, thread_ts, limit: @thread_scan_limit) do
      {:ok, messages} ->
        Enum.any?(messages, &mentions_bot?(&1["text"], bot.user_id))

      {:error, reason} ->
        Logger.warning(
          "ThreadPermission: failed to read thread #{channel}/#{thread_ts}, " <>
            "assuming not invited: #{inspect(reason)}"
        )

        false
    end
  end

  defp mentions_bot?(text, bot_user_id) when is_binary(text) and is_binary(bot_user_id) do
    String.contains?(text, "<@#{bot_user_id}>")
  end

  defp mentions_bot?(_text, _bot_user_id), do: false

  defp key(channel, thread_ts), do: {channel, thread_ts}

  defp put(key, verdict) do
    :ets.insert(@table, {key, verdict, System.monotonic_time(:millisecond)})
  rescue
    # Table not started (e.g. Slack integration disabled in tests) — caching
    # is an optimisation, never a reason to drop a message.
    ArgumentError -> true
  end

  defp lookup(key) do
    case :ets.lookup(@table, key) do
      [{^key, verdict, inserted_at}] ->
        if fresh?(verdict, inserted_at), do: {:ok, verdict}, else: :miss

      [] ->
        :miss
    end
  rescue
    # Table not started (e.g. Slack integration disabled in tests) — treat as
    # a miss so the caller falls back to the Slack lookup.
    ArgumentError -> :miss
  end

  defp fresh?(verdict, inserted_at) do
    ttl = if verdict == :allowed, do: @allowed_ttl_ms, else: @denied_ttl_ms
    System.monotonic_time(:millisecond) - inserted_at < ttl
  end

  @impl true
  def init(nil) do
    :ets.new(@table, [:named_table, :public, :set, read_concurrency: true])
    schedule_sweep()
    {:ok, nil}
  end

  @impl true
  def handle_info(:sweep, state) do
    now = System.monotonic_time(:millisecond)

    :ets.select_delete(@table, [
      {{:_, :allowed, :"$1"}, [{:<, :"$1", now - @allowed_ttl_ms}], [true]},
      {{:_, :denied, :"$1"}, [{:<, :"$1", now - @denied_ttl_ms}], [true]}
    ])

    schedule_sweep()
    {:noreply, state}
  end

  defp schedule_sweep do
    Process.send_after(self(), :sweep, @sweep_interval_ms)
  end
end
