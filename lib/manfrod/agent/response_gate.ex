defmodule Manfrod.Agent.ResponseGate do
  @moduledoc """
  Cheap LLM gate deciding how the agent should handle a plain
  (non-@mention, non-DM) thread reply in an already-active shared session:
  reply in full, just react with an emoji, react AND reply in full, or do
  nothing.

  Explicit @mentions and DMs never go through this gate — they always get a
  full response, since those are unambiguous direct address. This only
  applies to plain thread replies, so a busy multi-person channel thread
  doesn't get a bot reply to every single message.
  """

  require Logger

  alias Manfrod.LLM

  # Groq with llama-3.1-8b-instant: fast, reliable, generous free tier —
  # same choice as Manfrod.Memory.QueryExpander for lightweight decisions.
  @model "llama-3.1-8b-instant"
  @provider :groq

  @reaction_emojis ~w(thumbsup joy thinking_face fire heart smiling_face_with_3_hearts white_check_mark eyes tada)

  @system_message """
  You decide how an AI assistant present in a Slack thread should handle a
  new message. Choose exactly one:

  - "respond" - reply with a full text message. Only when directly
    addressed, asked a question it can answer, or the conversation clearly
    calls for it to contribute.
  - "react:<emoji>" - add ONLY an emoji reaction, no text. Use this fairly
    often — whenever a lightweight nod fits better than a full reply or
    staying silent, e.g. a message is funny, impressive, a clear
    success/completion, or otherwise worth a small acknowledgement.
  - "react_and_respond:<emoji>" - add an emoji reaction AND reply with a
    full text message. Use this when the message both calls for a real
    reply and clearly deserves an emoji on top — most notably when someone
    says something nice, complimentary, or appreciative about the
    assistant itself: react with a warm emoji like "heart" or
    "smiling_face_with_3_hearts" and also reply.
  - "ignore" - do nothing. Still the right choice for ordinary
    back-and-forth between people that isn't directed at or about the
    assistant and doesn't call for any acknowledgement.

  For "react:<emoji>" and "react_and_respond:<emoji>", <emoji> must be
  exactly one of: #{Enum.join(@reaction_emojis, ", ")}.

  Respond with exactly one line: "respond", "react:<emoji>",
  "react_and_respond:<emoji>", or "ignore".
  """

  @type decision :: :respond | {:react, String.t()} | {:react_and_respond, String.t()} | :ignore

  @doc """
  Decide how to handle new message(s), given recent conversation lines.

  Fails open to `:respond` on any LLM error — silently dropping a message
  forever is worse than an occasional unnecessary reply.
  """
  @spec decide([String.t()], [String.t()]) :: decision()
  def decide(recent_transcript, new_messages) do
    messages = [
      ReqLLM.Context.system(@system_message),
      ReqLLM.Context.user(build_prompt(recent_transcript, new_messages))
    ]

    case LLM.generate_simple(@model, messages,
           provider: @provider,
           purpose: :response_gate,
           timeout_ms: 8_000
         ) do
      {:ok, response} ->
        parse_decision(response)

      {:error, reason} ->
        Logger.debug("ResponseGate: LLM error, defaulting to respond: #{inspect(reason)}")
        :respond
    end
  end

  defp build_prompt(recent_transcript, new_messages) do
    history = if recent_transcript == [], do: "(none)", else: Enum.join(recent_transcript, "\n")
    new_text = Enum.join(new_messages, "\n")

    """
    Recent conversation:
    #{history}

    New message(s):
    #{new_text}

    What should the assistant do?
    """
  end

  defp parse_decision(response) when is_binary(response) do
    response
    |> String.trim()
    |> String.downcase()
    |> do_parse_decision()
  end

  defp parse_decision(_response), do: :respond

  defp do_parse_decision("respond" <> _), do: :respond

  defp do_parse_decision("react_and_respond:" <> rest) do
    case normalize_emoji(rest) do
      {:ok, emoji} -> {:react_and_respond, emoji}
      :error -> :respond
    end
  end

  defp do_parse_decision("react:" <> rest) do
    case normalize_emoji(rest) do
      {:ok, emoji} -> {:react, emoji}
      :error -> :ignore
    end
  end

  defp do_parse_decision("ignore" <> _), do: :ignore
  defp do_parse_decision(_), do: :respond

  defp normalize_emoji(rest) do
    emoji = rest |> String.trim() |> String.trim(":")
    if emoji in @reaction_emojis, do: {:ok, emoji}, else: :error
  end
end
