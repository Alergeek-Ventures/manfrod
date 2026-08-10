defmodule Manfrod.Slack.Kick do
  @moduledoc """
  Removing the bot from a channel thread, and saying goodbye on the way out.

  The single implementation behind both ways of asking:

  - the "Wyrzuć Manfroda" message shortcut, handled in
    `Manfrod.Slack.EventHandler`
  - the `leave_thread` tool (`Manfrod.Tools.Kick`), which the agent calls when
    someone in the thread just asks it to stop

  Both end up here so the two cannot drift: same persisted verdict (see
  `Manfrod.Slack.ThreadPermission.kick/3`) and the same goodbye, written for
  the thread it is leaving rather than picked from a list of canned lines.
  """

  require Logger

  alias Manfrod.LLM
  alias Manfrod.Slack.API
  alias Manfrod.Slack.ThreadPermission

  # The farewell is written for the thread it's leaving, on the small fast
  # model — same one the other lightweight calls use.
  @model "deepseek/deepseek-v4-flash"
  @provider :openrouter

  # How much of the thread the farewell gets to see. Enough to catch what the
  # conversation was about and how it was asked to go; more would just be
  # tokens spent on a one-line goodbye.
  @context_messages 8
  @context_chars 1_500

  @system_message """
  Jesteś Manfrod, firmowy asystent na Slacku. Ktoś w tym wątku właśnie
  poprosił, żebyś przestał się w nim udzielać, i faktycznie już wychodzisz.

  Napisz jedną krótką wiadomość pożegnalną:
  - W JĘZYKU WĄTKU. Rozpoznaj język z załączonych wiadomości i użyj dokładnie
    tego samego. Jeśli wątek jest po angielsku, pożegnaj się po angielsku;
    jeśli po polsku, po polsku. Przy mieszance wybierz język, w którym
    poproszono Cię o wyjście. Bez kontekstu użyj polskiego.
  - lekko smutną, ale bez dramatyzowania i bez proszenia się o powrót
  - nawiązującą do tego konkretnego wątku, jeśli z kontekstu widać, o czym był
  - z informacją, że wystarczy Cię oznaczyć (@Manfrod), żebyś wrócił
  - maksymalnie 2 zdania, jedno emoji
  - bez myślników "—" i "–", bez cudzysłowów wokół całości

  Odpowiedz samą treścią wiadomości, niczym więcej.
  """

  # Used only when the model call fails — the farewell is best-effort, but
  # leaving without a word would read like a crash.
  @fallback_farewell "Ok, znikam z tego wątku. 😔 Gdybyście mnie potrzebowali, wystarczy mnie oznaczyć."

  @doc """
  Kick the bot out of `thread_ts` in `channel` and post a farewell there.

  `attrs` is passed through to `ThreadPermission.kick/3` — `:user_id`,
  `:slack_user_id` and `:source`.

  Returns `:already_kicked` when the thread was already off-limits, so callers
  can avoid posting a second goodbye into a thread the bot has already left.
  """
  @spec run(String.t(), String.t(), String.t(), map()) ::
          :ok | :already_kicked | {:error, term()}
  def run(token, channel, thread_ts, attrs \\ %{})

  def run(token, channel, thread_ts, attrs)
      when is_binary(token) and is_binary(channel) and is_binary(thread_ts) do
    if ThreadPermission.kicked?(channel, thread_ts) do
      :already_kicked
    else
      case ThreadPermission.kick(channel, thread_ts, attrs) do
        :ok ->
          # Deliberately after the kick is recorded: the farewell is a
          # courtesy, and a slow or failing model must not be able to keep the
          # bot talking in a thread it has already been thrown out of.
          say_goodbye(token, channel, thread_ts)
          :ok

        {:error, reason} ->
          {:error, reason}
      end
    end
  end

  def run(_token, channel, thread_ts, _attrs) do
    Logger.warning(
      "Slack Kick: refusing to kick without a channel and thread " <>
        "(channel=#{inspect(channel)}, thread_ts=#{inspect(thread_ts)})"
    )

    {:error, :missing_thread}
  end

  @doc """
  Write the goodbye for this particular thread.

  Reads the tail of the thread so the message can refer to what was actually
  going on in it, and match the language it was being held in.

  Falls back to a fixed Polish line if the model is unavailable — that is the
  house language, and the alternative is leaving without a word.
  """
  @spec farewell(String.t(), String.t(), String.t()) :: String.t()
  def farewell(token, channel, thread_ts) do
    messages = [
      ReqLLM.Context.system(@system_message),
      ReqLLM.Context.user(thread_context(token, channel, thread_ts))
    ]

    case LLM.generate_simple(@model, messages,
           provider: @provider,
           purpose: :farewell,
           timeout_ms: 8_000
         ) do
      {:ok, text} when is_binary(text) ->
        case String.trim(text) do
          "" -> @fallback_farewell
          farewell -> farewell
        end

      {:error, reason} ->
        Logger.debug("Slack Kick: farewell generation failed, using fallback: #{inspect(reason)}")

        @fallback_farewell
    end
  end

  # The last few messages, oldest first, as plain "author: text" lines. On any
  # API trouble the model simply writes a generic goodbye instead.
  defp thread_context(token, channel, thread_ts) do
    case API.list_thread_replies(token, channel, thread_ts, limit: 200) do
      {:ok, messages} ->
        messages
        |> Enum.take(-@context_messages)
        |> Enum.map_join("\n", fn message ->
          "#{message["user_name"] || message["user"] || "ktoś"}: #{message["text"]}"
        end)
        |> String.slice(0, @context_chars)
        |> case do
          "" -> "(brak kontekstu wątku)"
          context -> "Ostatnie wiadomości w wątku:\n\n#{context}"
        end

      {:error, _reason} ->
        "(brak kontekstu wątku)"
    end
  end

  # The goodbye is best-effort: the thread is already off-limits by the time
  # this runs, so a failed post costs politeness, not correctness.
  defp say_goodbye(token, channel, thread_ts) do
    case API.post("chat.postMessage", token, %{
           channel: channel,
           thread_ts: thread_ts,
           text: farewell(token, channel, thread_ts)
         }) do
      {:ok, _} ->
        :ok

      {:error, reason} ->
        Logger.warning(
          "Slack Kick: left #{channel}/#{thread_ts} but could not post the farewell: " <>
            inspect(reason)
        )

        :ok
    end
  end
end
