defmodule Manfrod.Slack.ActivityHandler do
  @moduledoc """
  Subscribes to the PubSub event bus and delivers Agent activity to Slack.

  Handles the differences between DM threads (assistant surface) and channel
  threads (@mention surface):

  - **DM threads** use `assistant.threads.setStatus` to show typing indicators,
    which auto-clear when the bot sends a reply. The final response is posted
    directly as a threaded reply.
  - **Channel threads** post a placeholder message ("Thinking...") and update
    it in-place as the Agent progresses through actions and its final response.

  Handles events from any source (`:slack`, `:proactive`, etc.) as long as
  they carry a `reply_to` map with `channel` and `thread_ts`.

  Also supports `start_thread/1` for proactive messages — creates a new
  thread in a DM channel by posting a placeholder, returning the thread_ts.
  """

  use GenServer

  require Logger

  alias Manfrod.Events
  alias Manfrod.Events.Activity
  alias Manfrod.Slack.API
  alias Manfrod.Slack.MessageServer
  alias Manfrod.Slack.Mrkdwn
  alias Manfrod.Slack.ThreadTitle

  # ---------------------------------------------------------------------------
  # Public API
  # ---------------------------------------------------------------------------

  def start_link(bot_token) do
    GenServer.start_link(__MODULE__, bot_token, name: __MODULE__)
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
  def init(bot_token) do
    Events.subscribe_global()
    Logger.info("Slack.ActivityHandler started, subscribed to global activity events")
    {:ok, %{bot_token: bot_token, pending: %{}}}
  end

  # -- start_thread (for proactive messages) ----------------------------------

  @impl true
  def handle_call({:start_thread, channel}, _from, state) do
    MessageServer.ensure_started(state.bot_token, channel)

    case API.post("chat.postMessage", state.bot_token, %{
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
    # Skip if placeholder already exists (e.g. from start_thread)
    state =
      if get_in(state, [:pending, {channel, thread_ts}]) do
        state
      else
        if dm_channel?(channel) do
          set_status(state.bot_token, channel, thread_ts, "is thinking...")
          state
        else
          MessageServer.ensure_started(state.bot_token, channel)

          case API.post("chat.postMessage", state.bot_token, %{
                 channel: channel,
                 thread_ts: thread_ts,
                 text: ":hourglass_flowing_sand: Thinking..."
               }) do
            {:ok, %{"ts" => placeholder_ts}} ->
              put_in(state, [:pending, {channel, thread_ts}], %{placeholder_ts: placeholder_ts})

            {:error, reason} ->
              Logger.error(
                "Slack ActivityHandler failed to post placeholder to #{channel}: #{inspect(reason)}"
              )

              state
          end
        end
      end

    {:noreply, state}
  end

  # -- :action_started --------------------------------------------------------

  def handle_info(
        {:activity,
         %Activity{
           type: :action_started,
           reply_to: %{channel: channel, thread_ts: thread_ts}
         } = activity},
        state
      ) do
    action_name = activity.meta.action

    if dm_channel?(channel) do
      set_status(state.bot_token, channel, thread_ts, "is using #{action_name}...")
    else
      case get_in(state, [:pending, {channel, thread_ts}, :placeholder_ts]) do
        nil ->
          :ok

        placeholder_ts ->
          case API.post("chat.update", state.bot_token, %{
                 channel: channel,
                 ts: placeholder_ts,
                 text: ":hourglass_flowing_sand: Using #{action_name}..."
               }) do
            {:ok, _} ->
              :ok

            {:error, reason} ->
              Logger.error(
                "Slack ActivityHandler failed to update placeholder in #{channel}: #{inspect(reason)}"
              )
          end
      end
    end

    {:noreply, state}
  end

  # -- :responding ------------------------------------------------------------

  def handle_info(
        {:activity,
         %Activity{
           type: :responding,
           reply_to: %{channel: channel, thread_ts: thread_ts}
         } = activity},
        state
      ) do
    content = Mrkdwn.from_markdown(activity.meta.content)

    state =
      if dm_channel?(channel) do
        case get_in(state, [:pending, {channel, thread_ts}, :placeholder_ts]) do
          nil ->
            MessageServer.ensure_started(state.bot_token, channel)

            MessageServer.send_message(channel, %{
              thread_ts: thread_ts,
              text: content
            })

            state

          placeholder_ts ->
            MessageServer.ensure_started(state.bot_token, channel)

            MessageServer.send_message(channel, %{
              thread_ts: thread_ts,
              text: content
            })

            update_thread_title(state.bot_token, channel, placeholder_ts, content)

            {_, state} = pop_in(state, [:pending, {channel, thread_ts}])
            state
        end
      else
        case get_in(state, [:pending, {channel, thread_ts}, :placeholder_ts]) do
          nil ->
            MessageServer.ensure_started(state.bot_token, channel)

            MessageServer.send_message(channel, %{
              thread_ts: thread_ts,
              text: content
            })

            state

          placeholder_ts ->
            case API.post("chat.update", state.bot_token, %{
                   channel: channel,
                   ts: placeholder_ts,
                   text: content
                 }) do
              {:ok, _} ->
                :ok

              {:error, reason} ->
                Logger.error(
                  "Slack ActivityHandler failed to update response in #{channel}: #{inspect(reason)}"
                )
            end

            {_, state} = pop_in(state, [:pending, {channel, thread_ts}])
            state
        end
      end

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
    case API.add_reaction(state.bot_token, channel, ts, emoji) do
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

  def handle_info(
        {:activity,
         %Activity{
           type: :idle,
           reply_to: _reply_to
         }},
        state
      ) do
    {:noreply, state}
  end

  # -- Events without reply_to or with nil reply_to: ignore -------------------

  def handle_info({:activity, %Activity{}}, state) do
    {:noreply, state}
  end

  # ---------------------------------------------------------------------------
  # Helpers
  # ---------------------------------------------------------------------------

  defp dm_channel?("D" <> _), do: true
  defp dm_channel?(_), do: false

  defp update_thread_title(bot_token, channel, placeholder_ts, content) do
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

  defp set_status(bot_token, channel, thread_ts, status) do
    case API.post("assistant.threads.setStatus", bot_token, %{
           channel_id: channel,
           thread_ts: thread_ts,
           status: status
         }) do
      {:ok, _} ->
        :ok

      {:error, reason} ->
        Logger.error(
          "Slack ActivityHandler failed to set status in #{channel}: #{inspect(reason)}"
        )
    end
  end
end
