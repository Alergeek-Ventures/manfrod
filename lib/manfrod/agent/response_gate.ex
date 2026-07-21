defmodule Manfrod.Agent.ResponseGate do
  @moduledoc """
  Cheap LLM gate deciding whether the agent should reply to a plain
  (non-@mention, non-DM) thread reply in an already-active shared session.

  Explicit @mentions and DMs never go through this gate — they always get a
  response, since those are unambiguous direct address. This only applies to
  plain thread replies, so a busy multi-person channel thread doesn't get a
  bot reply to every single message.
  """

  require Logger

  alias Manfrod.LLM

  # Groq with llama-3.1-8b-instant: fast, reliable, generous free tier —
  # same choice as Manfrod.Memory.QueryExpander for lightweight decisions.
  @model "llama-3.1-8b-instant"
  @provider :groq

  @system_message """
  You decide whether an AI assistant present in a Slack thread should reply
  right now. The assistant should NOT reply to every message — only when it
  is directly addressed, asked a question it can answer, or the conversation
  clearly calls for it to contribute. Otherwise stay silent and let people
  talk to each other.

  Respond with exactly one word: "yes" or "no".
  """

  @doc """
  Decide whether the agent should respond, given recent conversation lines
  and the newest message(s) that just arrived.

  Fails open (`true`) on any LLM error — silently dropping a message forever
  is worse than an occasional unnecessary reply.
  """
  @spec should_respond?([String.t()], [String.t()]) :: boolean()
  def should_respond?(recent_transcript, new_messages) do
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
        true
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

    Should the assistant reply now? Answer "yes" or "no".
    """
  end

  defp parse_decision(response) when is_binary(response) do
    response
    |> String.trim()
    |> String.downcase()
    |> String.starts_with?("yes")
  end

  defp parse_decision(_response), do: true
end
