defmodule Manfrod.Slack.ThreadTitle do
  @moduledoc """
  Generates a short thread-root title for a proactive DM, from the actual
  message content the agent is about to send — used by
  `Manfrod.Slack.ActivityHandler` to replace the "Thinking..." placeholder
  once the reply is ready.
  """

  require Logger

  alias Manfrod.LLM

  @model "llama-3.1-8b-instant"
  @provider :groq

  @system_message """
  You write a short Slack thread title (3-8 words, under 60 characters) for
  a message a bot is about to send someone. Base it only on the message
  below — match its own language and tone, and make it feel personal and
  specific to that message, not generic. E.g. for a message about an
  upcoming holiday on a date, something like "Święto ... w dniu ...". No
  quotes, no emoji, no trailing punctuation. Reply with only the title.
  """

  @spec generate(String.t()) :: String.t()
  def generate(content) do
    messages = [
      ReqLLM.Context.system(@system_message),
      ReqLLM.Context.user(content)
    ]

    case LLM.generate_simple(@model, messages,
           provider: @provider,
           purpose: :thread_title,
           timeout_ms: 8_000
         ) do
      {:ok, title} when is_binary(title) ->
        clean(title, content)

      {:error, reason} ->
        Logger.debug("ThreadTitle: LLM error, falling back to truncation: #{inspect(reason)}")
        fallback(content)
    end
  end

  defp clean(title, content) do
    case title |> String.trim() |> String.trim("\"") do
      "" -> fallback(content)
      cleaned -> cleaned
    end
  end

  defp fallback(content) do
    content
    |> String.trim()
    |> String.split("\n", parts: 2)
    |> List.first()
    |> to_string()
    |> String.slice(0, 99)
  end
end
