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

  Being asked to leave is the one message the gate must not swallow: only a
  full turn can call `Manfrod.Tools.Kick`'s `leave_thread`, so anything short
  of `:respond` there silently ignores the request.
  """

  require Logger

  alias Manfrod.LLM

  # DeepSeek V4 Flash over OpenRouter — same choice as
  # Manfrod.Memory.QueryExpander for lightweight decisions.
  @model "deepseek/deepseek-v4-flash"
  @provider :openrouter

  @reaction_emojis ~w(thumbsup joy thinking_face fire heart smiling_face_with_3_hearts white_check_mark eyes tada)

  @system_message """
  You decide how an AI assistant present in a Slack thread should handle a
  new message. Choose exactly one:

  - "respond" - reply with a full text message. When the message is
    directed at the assistant, asks it something it can answer, or the
    conversation clearly calls for it to contribute. The assistant appears
    in the transcript as "Manfrod". Treat these as directed at it:
    - it is addressed by name ("Manfrod, ..."), even without an @mention
    - the message corrects, disputes or adds to something Manfrod just said
      (e.g. Manfrod wrote "z Escape" and the reply is just "z Scape")
    - someone complains Manfrod did not answer or tells it to answer
      ("to odpowiedz", "halo?", "zghostowałeś mnie", "?")
    - a follow-up question right after Manfrod's own reply that only makes
      sense as a question to Manfrod
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
  - "ignore" - do nothing. The right choice for ordinary back-and-forth
    between people that isn't directed at or about the assistant and
    doesn't call for any acknowledgement. When in doubt whether a message
    is meant for the assistant, do not choose "ignore": a missed question
    is far worse than an unneeded reply.

  One case overrides all of the above: if the message asks the assistant to
  stop replying in this thread, to leave, or to butt out (e.g. "przestań się
  tu udzielać", "zostaw nas", "nie odzywaj się więcej w tym wątku", "stop
  replying here"), always choose "respond" — never react or ignore. Acting
  on that request is something only a full turn can do, so a silent nod
  would quietly refuse it.

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

  # A line can carry a whole backfilled thread; the gate needs the gist of the
  # conversation, and the end of a line is where the actual message is.
  @line_limit 800

  defp build_prompt(recent_transcript, new_messages) do
    history =
      if recent_transcript == [],
        do: "(none)",
        else: Enum.map_join(recent_transcript, "\n", &tail/1)

    new_text = Enum.map_join(new_messages, "\n", &tail/1)

    """
    Recent conversation:
    #{history}

    New message(s):
    #{new_text}

    What should the assistant do?
    """
  end

  defp tail(line) do
    if String.length(line) > @line_limit do
      "…" <> String.slice(line, -@line_limit, @line_limit)
    else
      line
    end
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
