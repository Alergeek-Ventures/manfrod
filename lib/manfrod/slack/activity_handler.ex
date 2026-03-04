defmodule Manfrod.Slack.ActivityHandler do
  @moduledoc """
  Subscribes to the PubSub event bus and delivers Agent activity to Slack.

  Handles the differences between DM threads (assistant surface) and channel
  threads (@mention surface):

  - **DM threads** use `assistant.threads.setStatus` to show typing indicators,
    which auto-clear when the bot sends a reply.
  - **Channel threads** post a placeholder message ("Thinking...") and update
    it in-place as the Agent progresses through actions and its final response.
  """

  use GenServer

  require Logger

  alias Manfrod.Events
  alias Manfrod.Events.Activity
  alias Manfrod.Slack.API
  alias Manfrod.Slack.MessageServer
  alias Manfrod.Slack.Mrkdwn

  # ---------------------------------------------------------------------------
  # Public API
  # ---------------------------------------------------------------------------

  def start_link(bot_token) do
    GenServer.start_link(__MODULE__, bot_token, name: __MODULE__)
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

  # -- :thinking (Slack only) -------------------------------------------------

  @impl true
  def handle_info(
        {:activity, %Activity{type: :thinking, source: :slack, reply_to: reply_to}},
        state
      ) do
    %{channel: channel, thread_ts: thread_ts} = reply_to

    state =
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

    {:noreply, state}
  end

  # -- :action_started (Slack only) -------------------------------------------

  def handle_info(
        {:activity,
         %Activity{type: :action_started, source: :slack, reply_to: reply_to} = activity},
        state
      ) do
    %{channel: channel, thread_ts: thread_ts} = reply_to
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

  # -- :responding (Slack only) -----------------------------------------------

  def handle_info(
        {:activity, %Activity{type: :responding, source: :slack, reply_to: reply_to} = activity},
        state
      ) do
    %{channel: channel, thread_ts: thread_ts} = reply_to
    content = Mrkdwn.from_markdown(activity.meta.content)

    state =
      if dm_channel?(channel) do
        # setStatus auto-clears when we send a reply
        MessageServer.ensure_started(state.bot_token, channel)

        MessageServer.send_message(channel, %{
          thread_ts: thread_ts,
          text: content
        })

        state
      else
        case get_in(state, [:pending, {channel, thread_ts}, :placeholder_ts]) do
          nil ->
            # No placeholder — post a new message
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

  # -- Non-Slack events: ignore -----------------------------------------------

  def handle_info({:activity, %Activity{source: source}}, state) when source != :slack do
    {:noreply, state}
  end

  # -- Other Slack events we don't handle (idle, narrating, etc.) -------------

  def handle_info({:activity, %Activity{source: :slack}}, state) do
    {:noreply, state}
  end

  # ---------------------------------------------------------------------------
  # Helpers
  # ---------------------------------------------------------------------------

  defp dm_channel?("D" <> _), do: true
  defp dm_channel?(_), do: false

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
