defmodule Manfrod.Slack.EventHandler do
  @moduledoc """
  Translates inbound Slack events into `Agent.send_message/3` calls.

  Resolves Slack user IDs to Manfrod users via `Accounts.find_or_create_by_slack_id/3`
  (auto-provisioning). Each message is routed to the per-session Agent process.

  ## DM-first requirement

  Users are created only on their first DM interaction, which captures the
  DM channel ID (`slack_dm_channel_id`). Channel @mentions from unknown users
  are rejected with a "DM me first" reply.

  Called by `Manfrod.Slack.Socket` via `Task.Supervisor` — each invocation
  runs in its own process. This is a plain module, not a GenServer.
  """

  require Logger

  alias Manfrod.Accounts
  alias Manfrod.Agent
  alias Manfrod.Slack.API

  @doc """
  Handle an incoming Slack event.

  ## Supported event types

  - `"message"` — Two sub-cases:
    - **DMs**: Creates user on first interaction (DM-first). Forwards the
      text to the Agent with session scoping.
    - **Channel thread replies**: Only forwarded if the user is known AND an
      Agent session already exists for that thread (bot was previously
      @mentioned). Top-level channel messages without @mention are ignored.
  - `"app_mention"` — Channel @mentions. Requires user to already exist
    (must have DMed the bot first). Strips the bot mention prefix and
    includes channel context (name + user) before forwarding.

  All other event types are logged at debug level and ignored.
  """
  @spec handle_event(String.t(), map(), Manfrod.Slack.Bot.t()) :: :ok
  def handle_event("message", event, bot) do
    text = event["text"]
    slack_user_id = event["user"]
    channel = event["channel"]

    if text_present?(text) and slack_user_id do
      if dm_channel?(channel) do
        handle_dm_message(bot, event, text, slack_user_id, channel)
      else
        handle_channel_thread_reply(event, bot, text, slack_user_id, channel)
      end
    else
      Logger.debug("Slack EventHandler ignoring message with no text or no user")
    end

    :ok
  end

  def handle_event("app_mention", event, bot) do
    raw_text = event["text"]
    slack_user_id = event["user"]
    channel = event["channel"]
    thread_ts = event["thread_ts"] || event["ts"]
    session_key = "#{channel}:#{thread_ts}"

    cleaned_text =
      if raw_text do
        raw_text
        |> String.replace(~r/<@#{Regex.escape(bot.user_id)}>/, "")
        |> String.trim()
      end

    if text_present?(cleaned_text) and slack_user_id do
      case Accounts.get_user_by_slack_id(slack_user_id) do
        nil ->
          # User hasn't DMed the bot yet — reply with instructions
          Logger.info(
            "Slack EventHandler: unknown user #{slack_user_id} in channel, sending DM-first message"
          )

          API.post("chat.postMessage", bot.token, %{
            channel: channel,
            thread_ts: thread_ts,
            text: "DM me first to get started!"
          })

        user ->
          channel_context = resolve_channel_context(bot.token, channel, slack_user_id)
          content_with_context = "[#{channel_context}]\n#{cleaned_text}"

          Agent.send_message(user.id, session_key, %{
            content: content_with_context,
            source: :slack,
            reply_to: %{channel: channel, thread_ts: thread_ts}
          })
      end
    else
      Logger.debug("Slack EventHandler ignoring app_mention with no text after stripping mention")
    end

    :ok
  end

  def handle_event(type, _event, _bot) do
    Logger.debug("Slack EventHandler ignoring event type: #{type}")
    :ok
  end

  # -- DM messages: create user on first interaction, forward to Agent ---------

  defp handle_dm_message(bot, event, text, slack_user_id, channel) do
    thread_ts = event["thread_ts"] || event["ts"]
    session_key = "#{channel}:#{thread_ts}"

    name =
      case API.fetch_user_name(bot.token, slack_user_id) do
        {:ok, name} -> name
        :error -> nil
      end

    {:ok, user} = Accounts.find_or_create_by_slack_id(slack_user_id, channel, name)

    Agent.send_message(user.id, session_key, %{
      content: text,
      source: :slack,
      reply_to: %{channel: channel, thread_ts: thread_ts}
    })
  end

  # -- Channel thread replies: only respond if bot is already in the thread ---

  defp handle_channel_thread_reply(event, bot, text, slack_user_id, channel) do
    # Only handle replies inside existing threads, not top-level channel messages.
    # A thread reply has thread_ts set (pointing to the parent message).
    thread_ts = event["thread_ts"]

    if thread_ts do
      session_key = "#{channel}:#{thread_ts}"

      case Accounts.get_user_by_slack_id(slack_user_id) do
        nil ->
          Logger.debug(
            "Slack EventHandler ignoring channel thread reply from unknown user #{slack_user_id}"
          )

        user ->
          # Only forward if an Agent session already exists for this thread
          # (i.e. the bot was @mentioned in this thread before)
          if session_exists?(user.id, session_key) do
            # Strip bot mention if present (user might @mention again in the thread)
            cleaned_text =
              text
              |> String.replace(~r/<@#{Regex.escape(bot.user_id)}>/, "")
              |> String.trim()

            if text_present?(cleaned_text) do
              Agent.send_message(user.id, session_key, %{
                content: cleaned_text,
                source: :slack,
                reply_to: %{channel: channel, thread_ts: thread_ts}
              })
            end
          else
            Logger.debug(
              "Slack EventHandler ignoring channel thread reply — no active session for #{session_key}"
            )
          end
      end
    else
      Logger.debug("Slack EventHandler ignoring top-level channel message without @mention")
    end
  end

  defp session_exists?(user_id, session_key) do
    Registry.lookup(Manfrod.Agent.Registry, {user_id, session_key}) != []
  end

  defp dm_channel?("D" <> _), do: true
  defp dm_channel?(_), do: false

  defp text_present?(nil), do: false
  defp text_present?(""), do: false
  defp text_present?(_text), do: true

  defp resolve_channel_context(token, channel, slack_user_id) do
    channel_name = resolve_channel_name(token, channel)
    user_name = resolve_user_name(token, slack_user_id)

    parts =
      ["Slack channel: ##{channel_name}" | if(user_name, do: ["from: #{user_name}"], else: [])]

    Enum.join(parts, ", ")
  end

  defp resolve_channel_name(token, channel) do
    case API.get("conversations.info", token, %{channel: channel}) do
      {:ok, %{"channel" => %{"name" => name}}} -> name
      _ -> channel
    end
  end

  defp resolve_user_name(token, slack_user_id) do
    case API.fetch_user_name(token, slack_user_id) do
      {:ok, name} -> name
      :error -> nil
    end
  end
end
