defmodule Manfrod.Slack.UserContext do
  @moduledoc """
  Where each user is currently looking in Slack.

  Agents get an `app_context_changed` event whenever the person switches to a
  different channel, thread or canvas while the app is open. That makes "streść
  mi to" or "kto tu odpowiadał?" answerable in a DM without the user pasting a
  link — the referent is whatever they were just reading.

  Entries are last-write-wins per user and expire after #{2} hours: a context
  older than that is more likely to mislead than to help, since the user has
  almost certainly moved on.

  This only records what Slack tells us. Whether the agent may actually *read*
  that channel is decided later, by `Manfrod.Slack.ThreadPermission` and the
  memory access levels — nothing here widens anyone's access.
  """

  use GenServer

  @table __MODULE__
  @ttl_ms :timer.hours(2)
  @sweep_interval_ms :timer.minutes(15)

  def start_link(_opts) do
    GenServer.start_link(__MODULE__, nil, name: __MODULE__)
  end

  @doc """
  Record the context a user just switched to. `app_context` is Slack's raw map
  (`"channel_id"`, `"thread_ts"`, ...); a nil or empty one clears the entry.
  """
  @spec put(String.t(), map() | nil) :: :ok
  def put(slack_user_id, app_context)
      when is_binary(slack_user_id) and is_map(app_context) and map_size(app_context) > 0 do
    :ets.insert(@table, {slack_user_id, app_context, System.monotonic_time(:millisecond)})
    :ok
  end

  def put(slack_user_id, _app_context) when is_binary(slack_user_id) do
    :ets.delete(@table, slack_user_id)
    :ok
  end

  @doc """
  The user's current context, or nil if unknown or expired.
  """
  @spec get(String.t()) :: map() | nil
  def get(slack_user_id) when is_binary(slack_user_id) do
    case :ets.lookup(@table, slack_user_id) do
      [{^slack_user_id, app_context, at}] ->
        if fresh?(at), do: app_context, else: nil

      [] ->
        nil
    end
  rescue
    # The table only exists once the Slack supervisor has started; callers in
    # tests or during boot get "no context" rather than an exception.
    ArgumentError -> nil
  end

  @doc """
  A one-line description of what the user is looking at, for injection into
  the agent's prompt — or nil when there is nothing useful to say.

  `resolve_channel_name` is a 1-arity fun so this module stays free of Slack
  API calls (and of the token needed to make them).
  """
  @spec describe(String.t(), (String.t() -> String.t() | nil)) :: String.t() | nil
  def describe(slack_user_id, resolve_channel_name) do
    with app_context when is_map(app_context) <- get(slack_user_id),
         channel_id when is_binary(channel_id) <- app_context["channel_id"],
         # A DM with the bot is not "somewhere else" — it's this conversation.
         false <- String.starts_with?(channel_id, "D") do
      name = resolve_channel_name.(channel_id) || channel_id
      thread = app_context["thread_ts"]

      if thread do
        "The user is currently viewing a thread in ##{name} " <>
          "(channel #{channel_id}, thread_ts #{thread}). If they say \"this\", " <>
          "\"tu\" or \"tego wątku\" without naming anything, they most likely mean it."
      else
        "The user is currently viewing ##{name} (channel #{channel_id}). " <>
          "If they say \"this\", \"tu\" or \"tego kanału\" without naming " <>
          "anything, they most likely mean it."
      end
    else
      _ -> nil
    end
  end

  # ---------------------------------------------------------------------------
  # GenServer callbacks
  # ---------------------------------------------------------------------------

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

  defp fresh?(at), do: at > System.monotonic_time(:millisecond) - @ttl_ms

  defp schedule_sweep do
    Process.send_after(self(), :sweep, @sweep_interval_ms)
  end
end
