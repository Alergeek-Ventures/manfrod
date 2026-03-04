defmodule Manfrod.Slack.EventHandler do
  @moduledoc """
  Translates inbound Slack events into `Agent.send_message/1` calls.

  Called by `Manfrod.Slack.Socket` via `Task.Supervisor` — each invocation
  runs in its own process. This is a plain module, not a GenServer.
  """

  require Logger

  alias Manfrod.Agent

  @doc """
  Handle an incoming Slack event.

  ## Supported event types

  - `"message"` — DM messages. Forwards the text to the Agent with the
    channel and thread timestamp as `reply_to`.
  - `"app_mention"` — Channel @mentions. Strips the bot mention prefix
    from the text before forwarding.

  All other event types are logged at debug level and ignored.
  """
  @spec handle_event(String.t(), map(), Manfrod.Slack.Bot.t()) :: :ok
  def handle_event("message", event, _bot) do
    text = event["text"]
    channel = event["channel"]
    thread_ts = event["thread_ts"] || event["ts"]

    if text_present?(text) do
      Agent.send_message(%{
        content: text,
        source: :slack,
        reply_to: %{channel: channel, thread_ts: thread_ts}
      })
    else
      Logger.debug("Slack EventHandler ignoring message with no text")
    end

    :ok
  end

  def handle_event("app_mention", event, bot) do
    raw_text = event["text"]
    channel = event["channel"]
    thread_ts = event["thread_ts"] || event["ts"]

    cleaned_text =
      if raw_text do
        raw_text
        |> String.replace(~r/<@#{Regex.escape(bot.user_id)}>/, "")
        |> String.trim()
      end

    if text_present?(cleaned_text) do
      Agent.send_message(%{
        content: cleaned_text,
        source: :slack,
        reply_to: %{channel: channel, thread_ts: thread_ts}
      })
    else
      Logger.debug("Slack EventHandler ignoring app_mention with no text after stripping mention")
    end

    :ok
  end

  def handle_event(type, _event, _bot) do
    Logger.debug("Slack EventHandler ignoring event type: #{type}")
    :ok
  end

  defp text_present?(nil), do: false
  defp text_present?(""), do: false
  defp text_present?(_text), do: true
end
