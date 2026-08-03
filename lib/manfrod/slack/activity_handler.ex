defmodule Manfrod.Slack.ActivityHandler do
  @moduledoc """
  Subscribes to the PubSub event bus and delivers Agent activity to Slack.

  Handles events from any source (`:slack`, `:proactive`, etc.) as long as
  they carry a `reply_to` map with `channel` and `thread_ts`.

  ## How a turn is rendered

  1. `:thinking` — `assistant.threads.setStatus` shimmer, the only thing shown
     until there is real content.
  2. First `:response_chunk` or `:action_started` — opens a
     `Manfrod.Slack.StreamSession`, which posts a streaming message.
  3. `:response_chunk` — the answer appears as it is generated.
  4. `:action_started` / `:action_completed` — each tool call is a step inside
     one progress card, which spins until the turn ends. `:plan_titled` names
     that card once the agent has worked out what the job is; until then it
     carries a provisional label.
  5. `:responding` — finalizes the stream and attaches the feedback buttons.

  Streaming needs a recipient in channel threads (Slack shows the in-progress
  message only to that person until it is finalized) and can be turned off
  wholesale with `config :manfrod, :slack_streaming, false`. Whenever it is
  unavailable — a channel thread with no known author, a `chat.startStream`
  failure — every path falls back to the previous behaviour: a shimmer while
  working, then one complete message via `MessageServer`.

  Also supports `start_thread/1` for proactive messages — creates a new
  thread in a DM channel by posting a placeholder, returning the thread_ts.
  """

  use GenServer

  require Logger

  alias Manfrod.Events
  alias Manfrod.Events.Activity
  alias Manfrod.Slack.API
  alias Manfrod.Slack.Feedback
  alias Manfrod.Slack.MessageServer
  alias Manfrod.Slack.Mrkdwn
  alias Manfrod.Slack.StreamSession
  alias Manfrod.Slack.ThreadTitle

  # Threads whose title has already been generated, so a long conversation
  # doesn't re-title itself after every single answer. Pruned on a slow tick —
  # a stale entry only costs one skipped (already correct) title.
  @titled_ttl_ms :timer.hours(24)
  @prune_interval_ms :timer.hours(1)

  @provisional_plan_title "Pracuję nad tym"

  # ---------------------------------------------------------------------------
  # Public API
  # ---------------------------------------------------------------------------

  def start_link(bot) do
    GenServer.start_link(__MODULE__, bot, name: __MODULE__)
  end

  @doc """
  Create a new thread in a channel by posting a placeholder message.

  Returns `{:ok, thread_ts}` where `thread_ts` is the timestamp of the
  placeholder message, which becomes the thread root. The placeholder is
  registered in `pending` so that subsequent `:thinking` events for this
  thread will not post a duplicate.

  Used by `Manfrod.Proactive` to start new DM threads.
  """
  def start_thread(channel) do
    GenServer.call(__MODULE__, {:start_thread, channel})
  end

  # ---------------------------------------------------------------------------
  # GenServer callbacks
  # ---------------------------------------------------------------------------

  @impl true
  def init(bot) do
    Events.subscribe_global()
    Process.send_after(self(), :prune_titled, @prune_interval_ms)
    Logger.info("Slack.ActivityHandler started, subscribed to global activity events")
    {:ok, %{bot: bot, pending: %{}, streams: %{}, titled: %{}}}
  end

  # -- start_thread (for proactive messages) ----------------------------------

  @impl true
  def handle_call({:start_thread, channel}, _from, state) do
    MessageServer.ensure_started(state.bot.token, channel)

    case API.post("chat.postMessage", state.bot.token, %{
           channel: channel,
           text: ":hourglass_flowing_sand: Thinking..."
         }) do
      {:ok, %{"ts" => placeholder_ts}} ->
        state =
          put_in(state, [:pending, {channel, placeholder_ts}], %{placeholder_ts: placeholder_ts})

        {:reply, {:ok, placeholder_ts}, state}

      {:error, reason} ->
        Logger.error(
          "Slack ActivityHandler failed to start thread in #{channel}: #{inspect(reason)}"
        )

        {:reply, {:error, reason}, state}
    end
  end

  # -- :thinking --------------------------------------------------------------

  @impl true
  def handle_info(
        {:activity,
         %Activity{type: :thinking, reply_to: %{channel: channel, thread_ts: thread_ts}}},
        state
      ) do
    # Skip if a placeholder already exists (e.g. from start_thread), or if the
    # stream is already carrying the progress itself.
    unless get_in(state, [:pending, {channel, thread_ts}]) or
             streaming?(state, channel, thread_ts) do
      set_status(state.bot.token, channel, thread_ts, "is thinking...")
    end

    {:noreply, state}
  end

  # -- :response_chunk (incremental text) --------------------------------------

  def handle_info(
        {:activity,
         %Activity{type: :response_chunk, reply_to: %{channel: channel, thread_ts: thread_ts}} =
           activity},
        state
      ) do
    case ensure_stream(state, activity) do
      {:ok, state} ->
        StreamSession.text(channel, thread_ts, activity.meta.text)
        {:noreply, state}

      {:error, state} ->
        # No stream available here — the text still arrives whole on
        # :responding, so there is nothing to salvage and nothing to log.
        {:noreply, state}
    end
  end

  # -- :action_started --------------------------------------------------------

  def handle_info(
        {:activity,
         %Activity{type: :action_started, reply_to: %{channel: channel, thread_ts: thread_ts}} =
           activity},
        state
      ) do
    action_name = activity.meta.action

    case ensure_stream(state, activity) do
      {:ok, state} ->
        # Names the card until the agent's own title arrives on :plan_titled.
        # Never overwrites a title already set, so a second tool call cannot
        # revert the card to this placeholder. Deliberately vague rather than
        # the tool's name: the first step below it already says that, and this
        # is also what stays on the card if the title never generates.
        StreamSession.plan_default(channel, thread_ts, @provisional_plan_title)

        StreamSession.task(channel, thread_ts, %{
          id: activity.meta.action_id,
          title: humanize(action_name),
          status: "in_progress",
          details: args_preview(activity.meta[:args])
        })

        {:noreply, state}

      {:error, state} ->
        set_status(state.bot.token, channel, thread_ts, "is using #{action_name}...")
        {:noreply, state}
    end
  end

  # -- :plan_titled (the agent's own name for this turn's work) ----------------

  def handle_info(
        {:activity,
         %Activity{type: :plan_titled, reply_to: %{channel: channel, thread_ts: thread_ts}} =
           activity},
        state
      ) do
    # Generated asynchronously, so it can land after the turn is over — the
    # cast is dropped harmlessly if the session is already gone.
    if streaming?(state, channel, thread_ts) do
      StreamSession.plan(channel, thread_ts, activity.meta.title)
    end

    {:noreply, state}
  end

  # -- :action_completed ------------------------------------------------------

  def handle_info(
        {:activity,
         %Activity{type: :action_completed, reply_to: %{channel: channel, thread_ts: thread_ts}} =
           activity},
        state
      ) do
    if streaming?(state, channel, thread_ts) do
      # `details` is deliberately omitted: the session carries over what the
      # step was announced with (its arguments), and the result belongs in
      # `output`, underneath it.
      StreamSession.task(channel, thread_ts, %{
        id: activity.meta.action_id,
        title: humanize(activity.meta.action),
        status: if(activity.meta.success, do: "complete", else: "error"),
        output: result_summary(activity.meta)
      })
    end

    {:noreply, state}
  end

  # -- :responding ------------------------------------------------------------

  def handle_info(
        {:activity,
         %Activity{type: :responding, reply_to: %{channel: channel, thread_ts: thread_ts}} =
           activity},
        state
      ) do
    content = activity.meta.content
    key = {channel, thread_ts}

    {stream, state} = pop_in(state, [:streams, key])

    delivered =
      if stream do
        finish_stream(channel, thread_ts, content, activity)
      else
        :not_streaming
      end

    if delivered == :not_streaming do
      post_message(state, channel, thread_ts, content)
    end

    state =
      state
      |> finalize_placeholder(channel, thread_ts, content)
      |> maybe_set_title(channel, thread_ts, content)

    {:noreply, state}
  end

  # -- :interrupted (new message mid-turn) -------------------------------------

  def handle_info(
        {:activity,
         %Activity{type: :interrupted, reply_to: %{channel: channel, thread_ts: thread_ts}}},
        state
      ) do
    {stream, state} = pop_in(state, [:streams, {channel, thread_ts}])
    if stream, do: StreamSession.abort(channel, thread_ts)
    {:noreply, state}
  end

  # -- :reacted (emoji reaction instead of a full reply) -----------------------

  def handle_info(
        {:activity,
         %Activity{
           type: :reacted,
           reply_to: %{channel: channel},
           meta: %{emoji: emoji, ts: ts}
         }},
        state
      )
      when is_binary(emoji) and is_binary(ts) do
    case API.add_reaction(state.bot.token, channel, ts, emoji) do
      {:ok, _} ->
        :ok

      {:error, "already_reacted"} ->
        :ok

      {:error, reason} ->
        Logger.warning(
          "Slack ActivityHandler failed to add reaction :#{emoji}: in #{channel}: #{inspect(reason)}"
        )
    end

    {:noreply, state}
  end

  def handle_info({:activity, %Activity{type: :reacted}}, state), do: {:noreply, state}

  # -- :idle (conversation wrap-up) --------------------------------------------

  def handle_info({:activity, %Activity{type: :idle}}, state) do
    {:noreply, state}
  end

  # -- Events without reply_to or with nil reply_to: ignore -------------------

  def handle_info({:activity, %Activity{}}, state) do
    {:noreply, state}
  end

  def handle_info(:prune_titled, state) do
    cutoff = System.monotonic_time(:millisecond) - @titled_ttl_ms
    titled = Map.filter(state.titled, fn {_key, at} -> at > cutoff end)
    Process.send_after(self(), :prune_titled, @prune_interval_ms)
    {:noreply, %{state | titled: titled}}
  end

  # ---------------------------------------------------------------------------
  # Streaming
  # ---------------------------------------------------------------------------

  defp streaming?(state, channel, thread_ts) do
    Map.has_key?(state.streams, {channel, thread_ts})
  end

  # Start a stream for this turn, or report that this thread can't have one.
  # Idempotent: every event that produces content calls it, only the first
  # actually starts anything.
  defp ensure_stream(state, activity) do
    %{channel: channel, thread_ts: thread_ts} = activity.reply_to
    key = {channel, thread_ts}

    cond do
      Map.has_key?(state.streams, key) ->
        {:ok, state}

      not streaming_enabled?() ->
        {:error, state}

      true ->
        case recipient(state.bot, activity.reply_to, channel) do
          :unsupported ->
            {:error, state}

          recipient ->
            case StreamSession.ensure_started(state.bot.token, channel, thread_ts, recipient) do
              :ok ->
                {:ok, put_in(state, [:streams, key], %{session_key: activity.session_key})}

              {:error, reason} ->
                Logger.warning(
                  "Slack ActivityHandler could not start stream in #{channel}: #{inspect(reason)}"
                )

                {:error, state}
            end
        end
    end
  end

  defp streaming_enabled?, do: Application.get_env(:manfrod, :slack_streaming, true)

  # DMs stream to the conversation itself. A channel thread needs the person
  # the in-progress message belongs to; without a known author (a proactive
  # post, a reply_to built before this field existed) there is nobody to show
  # it to, so that thread gets the non-streamed path.
  defp recipient(_bot, _reply_to, "D" <> _), do: nil

  defp recipient(bot, reply_to, _channel) do
    case Map.get(reply_to, :slack_user_id) do
      slack_user_id when is_binary(slack_user_id) ->
        %{user_id: slack_user_id, team_id: bot.team_id}

      _ ->
        :unsupported
    end
  end

  defp finish_stream(channel, thread_ts, content, activity) do
    chunks =
      if feedback_supported?(channel) do
        [Feedback.buttons_chunk(activity.session_key)]
      else
        []
      end

    case StreamSession.finish(channel, thread_ts, content, chunks) do
      :ok ->
        :ok

      {:error, :not_streaming} ->
        :not_streaming

      {:error, {:no_session, _reason}} ->
        # The session died before it could be finalized (idle watchdog, crash).
        # The answer itself has not been delivered, so send it normally.
        :not_streaming

      {:error, _reason} ->
        # stop_stream failed but the streamed content is on screen; posting the
        # whole answer again would duplicate it.
        :ok
    end
  end

  # The feedback element is part of the agent surface. Restricted to DMs
  # rather than assumed everywhere, so an unsupported block can never make a
  # channel reply fail to render.
  defp feedback_supported?("D" <> _), do: true
  defp feedback_supported?(_channel), do: false

  # ---------------------------------------------------------------------------
  # Non-streamed delivery
  # ---------------------------------------------------------------------------

  defp post_message(state, channel, thread_ts, content) do
    {text, blocks} = Mrkdwn.to_blocks(content)

    message =
      %{thread_ts: thread_ts, text: text}
      |> then(fn m -> if blocks, do: Map.put(m, :blocks, blocks), else: m end)

    MessageServer.ensure_started(state.bot.token, channel)
    MessageServer.send_message(channel, message)
  end

  # ---------------------------------------------------------------------------
  # Thread titles
  # ---------------------------------------------------------------------------

  # A proactive thread's root is a "Thinking..." placeholder; rewrite it to
  # something meaningful now that the reply exists.
  defp finalize_placeholder(state, channel, thread_ts, content) do
    case get_in(state, [:pending, {channel, thread_ts}, :placeholder_ts]) do
      nil ->
        state

      placeholder_ts ->
        rewrite_placeholder(state.bot.token, channel, placeholder_ts, content)
        {_, state} = pop_in(state, [:pending, {channel, thread_ts}])
        state
    end
  end

  defp rewrite_placeholder(bot_token, channel, placeholder_ts, content) do
    Task.start(fn ->
      title = ThreadTitle.generate(content)

      case API.post("chat.update", bot_token, %{
             channel: channel,
             ts: placeholder_ts,
             text: title
           }) do
        {:ok, _} ->
          :ok

        {:error, reason} ->
          Logger.error(
            "Slack ActivityHandler failed to update thread title in #{channel}: #{inspect(reason)}"
          )
      end
    end)
  end

  # Name the thread in the agent's Messages tab. Only assistant threads (DMs)
  # have that list, and only the first answer in a thread earns a title — a
  # later answer would rename a conversation the user already recognises.
  defp maybe_set_title(state, "D" <> _ = channel, thread_ts, content) do
    key = {channel, thread_ts}

    if Map.has_key?(state.titled, key) do
      state
    else
      bot_token = state.bot.token

      Task.start(fn ->
        title = ThreadTitle.generate(content)

        case API.set_title(bot_token, channel, thread_ts, title) do
          {:ok, _} ->
            :ok

          {:error, reason} ->
            Logger.warning(
              "Slack ActivityHandler failed to set thread title in #{channel}: #{inspect(reason)}"
            )
        end
      end)

      put_in(state, [:titled, key], System.monotonic_time(:millisecond))
    end
  end

  defp maybe_set_title(state, _channel, _thread_ts, _content), do: state

  # ---------------------------------------------------------------------------
  # Helpers
  # ---------------------------------------------------------------------------

  defp set_status(bot_token, channel, thread_ts, status) do
    case API.set_status(bot_token, channel, thread_ts, status) do
      {:ok, _} ->
        :ok

      {:error, reason} ->
        Logger.error(
          "Slack ActivityHandler failed to set status in #{channel}: #{inspect(reason)}"
        )
    end
  end

  defp humanize(action_name) when is_binary(action_name) do
    action_name
    |> String.replace("_", " ")
    |> String.capitalize()
  end

  defp humanize(action_name), do: to_string(action_name)

  @details_limit 120

  # Tool arguments arrive as a JSON string. Showing the decoded values reads
  # far better on a task card than raw JSON ("Kowalski, 2026-08-04" beats
  # {"name":"Kowalski","date":"2026-08-04"}), and an argument list that fails
  # to decode is simply not shown rather than dumped.
  defp args_preview(args) when is_binary(args) do
    case Jason.decode(args) do
      {:ok, decoded} when is_map(decoded) and map_size(decoded) > 0 ->
        decoded
        |> Enum.map(fn {_key, value} -> preview_value(value) end)
        |> Enum.reject(&(&1 == ""))
        |> Enum.join(", ")
        |> String.slice(0, @details_limit)

      _ ->
        nil
    end
  end

  defp args_preview(_args), do: nil

  defp preview_value(value) when is_binary(value), do: String.slice(value, 0, 60)
  defp preview_value(value) when is_number(value) or is_boolean(value), do: to_string(value)
  defp preview_value(_value), do: ""

  # What the step produced, shown under it on the card. Tool results are
  # already truncated by the agent; this collapses them to a single line,
  # because a card step is a glance, not a transcript.
  defp result_summary(%{result: result}) when is_binary(result) do
    case result |> String.split("\n", trim: true) |> Enum.reject(&(String.trim(&1) == "")) do
      [] -> nil
      [line] -> String.slice(line, 0, @details_limit)
      [line | rest] -> String.slice(line, 0, @details_limit) <> " (+#{length(rest)} lin.)"
    end
  end

  defp result_summary(_meta), do: nil
end
