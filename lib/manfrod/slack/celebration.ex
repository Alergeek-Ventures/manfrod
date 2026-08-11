defmodule Manfrod.Slack.Celebration do
  @moduledoc """
  Lets Manfrod join a congratulations thread he was never invited into.

  The normal rule is that the bot stays silent in a channel thread until
  someone @mentions it there (`Manfrod.Slack.ThreadPermission`). This is the
  one deliberate exception: when people are congratulating a colleague under
  a company post — a win, a launch, a nice video, a work anniversary — the
  bot chiming in with everyone else is the point, and waiting to be tagged
  would miss the moment.

  The judgement is the model's, not a keyword list's. Congratulations don't
  need the word "gratulacje" — "mega, duma!", "🔥🔥🔥", "Glückwunsch" and a
  reply in any language people happen to write in all count, and no regex
  covers that. So every plain reply in an uninvited thread gets read by a
  small model in the context of its whole thread, which is also what
  separates sincere praise from "gratuluję wytrwałości" sarcasm, condolences,
  or a plain thank-you exchange.

  What keeps that affordable is that it runs at most once per thread per
  `Manfrod.Slack.EventDedup` window: a burst of twenty replies costs one
  thread read and one model call, not twenty. And joining calls
  `ThreadPermission.allow/2`, so every later reply in that thread takes the
  ordinary invited path through `Manfrod.Agent.ResponseGate` and never comes
  back here — the bot congratulates once and then behaves like a normal
  thread participant.

  A thread the bot was thrown out of is never joined: "stop chiming in" covers
  good wishes too.
  """

  require Logger

  alias Manfrod.Agent
  alias Manfrod.LLM
  alias Manfrod.Slack.API
  alias Manfrod.Slack.EventDedup
  alias Manfrod.Slack.ThreadPermission

  # DeepSeek V4 Flash over OpenRouter — same choice as
  # `Manfrod.Agent.ResponseGate` for lightweight decisions.
  @model "deepseek/deepseek-v4-flash"
  @provider :openrouter

  @thread_limit 30

  @system_message """
  You judge a Slack thread on a company channel. People are replying under
  someone's post, and an AI assistant that was NOT tagged is deciding whether
  to add its own congratulations.

  Answer "join" only when all of these hold:
  - Someone in the thread is congratulating or praising a person (or a team)
    for something of theirs: a win, an award, a launch, a shipped project, a
    good video or post, a new role, an anniversary, a personal milestone.
  - The praise is sincere, not sarcastic, ironic or teasing.
  - The occasion is a happy one — never condolences, sympathy, sick leave,
    a farewell to someone being let go, or anything else where cheerful
    congratulations would be tactless.

  Judge the meaning, not the wording. Congratulations arrive in any language
  and often with no congratulatory word at all — "mega!", "duma", "jestem pod
  wrażeniem", a row of 🔥 or 👏, a heart emoji. All of those count. So does
  praise that never names the achievement, as long as the thread makes clear
  what is being celebrated.

  Answer "skip" for everything else, including:
  - Ordinary thanks between colleagues for day-to-day help ("dzięki za fix").
  - Work discussion, feedback or review of someone's output that is not
    celebration.
  - Announcements nobody is actually celebrating.
  - Threads where the assistant has already congratulated.
  - Anything you are unsure about — silence costs nothing here, an
    out-of-place "gratulacje!" is embarrassing.

  Respond with exactly one word: "join" or "skip".
  """

  @doc """
  Consider joining the congratulations in this thread.

  `access_channel_id` is the channel the Agent should resolve memory access
  against (`nil` for private conversations), as computed by the caller.

  Always returns `:ok` — this is a nice-to-have on the side of normal message
  handling, so every failure mode ends in the bot staying quiet.
  """
  @spec maybe_join(
          Manfrod.Slack.Bot.t(),
          map(),
          String.t(),
          String.t(),
          struct(),
          String.t() | nil
        ) ::
          :ok
  def maybe_join(bot, event, channel, thread_ts, user, access_channel_id) do
    cond do
      ThreadPermission.kicked?(channel, thread_ts) ->
        :ok

      # The one throttle in front of the model: a burst of replies in the same
      # thread costs one thread read and one call, not one per message.
      not EventDedup.first?({:celebration, channel, thread_ts}) ->
        :ok

      true ->
        join_if_confirmed(bot, event, channel, thread_ts, user, access_channel_id)
    end
  end

  @doc """
  Ask the small model whether these thread lines are a celebration the bot
  should join.

  Fails closed to `:skip`: unlike the response gate, nothing is lost by
  staying silent here.
  """
  @spec decide([String.t()]) :: :join | :skip
  def decide([]), do: :skip

  def decide(thread_lines) do
    messages = [
      ReqLLM.Context.system(@system_message),
      ReqLLM.Context.user("Thread:\n#{Enum.join(thread_lines, "\n")}\n\nJoin or skip?")
    ]

    case LLM.generate_simple(@model, messages,
           provider: @provider,
           purpose: :celebration,
           timeout_ms: 8_000
         ) do
      {:ok, response} ->
        parse_decision(response)

      {:error, reason} ->
        Logger.debug("Celebration: LLM error, staying quiet: #{inspect(reason)}")
        :skip
    end
  end

  defp parse_decision(response) when is_binary(response) do
    case response |> String.trim() |> String.downcase() do
      "join" <> _ -> :join
      _ -> :skip
    end
  end

  defp parse_decision(_response), do: :skip

  defp join_if_confirmed(bot, event, channel, thread_ts, user, access_channel_id) do
    case API.list_thread_replies(bot.token, channel, thread_ts, limit: @thread_limit) do
      {:ok, messages} ->
        # The bot having spoken here already means either it was invited (and
        # this code path is moot) or it has congratulated once — either way it
        # should not add a second set of good wishes.
        if Enum.any?(messages, &(&1["user"] == bot.user_id)) do
          :ok
        else
          messages
          |> format_thread(bot)
          |> decide()
          |> maybe_send(bot, event, channel, thread_ts, user, access_channel_id, messages)
        end

      {:error, reason} ->
        Logger.debug(
          "Celebration: could not read thread #{channel}/#{thread_ts}: #{inspect(reason)}"
        )

        :ok
    end
  end

  defp maybe_send(:skip, _bot, _event, _channel, _thread_ts, _user, _access, _messages), do: :ok

  defp maybe_send(:join, bot, event, channel, thread_ts, user, access_channel_id, messages) do
    Logger.info("Celebration: joining congratulations in #{channel}/#{thread_ts}")

    # Joining makes this a thread the bot belongs to, exactly as an @mention
    # would: people can reply to it, and further messages go through the
    # ordinary gate instead of coming back through this module.
    ThreadPermission.allow(channel, thread_ts)

    Agent.send_message(
      user.id,
      "#{channel}:#{thread_ts}",
      %{
        content: build_prompt(bot, channel, messages),
        source: :celebration,
        reply_to: %{channel: channel, thread_ts: thread_ts, slack_user_id: event["user"]},
        ts: event["ts"],
        # Nobody addressed the bot — the decision to speak was already made
        # above, so the gate must not overrule it.
        requires_gate: false
      },
      access_channel_id
    )

    :ok
  end

  defp build_prompt(bot, channel, messages) do
    channel_name = resolve_channel_name(bot.token, channel)

    """
    [Nobody mentioned you. You are reading ##{channel_name}, where people are
    congratulating someone in a thread, and you have decided to join in.]
    #{Enum.join(format_thread(messages, bot), "\n")}
    [End of thread]

    Add your own congratulations to this thread: one or two warm, specific
    sentences in the language the thread is written in. Mention what the
    person actually did. Do not ask questions, do not offer help, and do not
    explain why you are writing — just congratulate them like a colleague
    would.
    """
  end

  defp format_thread(messages, bot) do
    names = resolve_authors(messages, bot)

    for msg <- messages, present?(msg["text"]) do
      "#{author(msg, names, bot)}: #{msg["text"]}"
    end
  end

  defp resolve_authors(messages, bot) do
    messages
    |> Enum.map(& &1["user"])
    |> Enum.reject(&(is_nil(&1) or &1 == bot.user_id))
    |> Enum.uniq()
    |> Map.new(fn slack_user_id ->
      {slack_user_id, resolve_user_name(bot.token, slack_user_id)}
    end)
  end

  # Names carry the Slack ID too, so the agent can @mention the person it is
  # congratulating rather than guessing at a handle.
  defp author(msg, names, bot) do
    cond do
      msg["user"] == bot.user_id -> "Manfrod"
      msg["user"] && names[msg["user"]] -> "#{names[msg["user"]]} <#{msg["user"]}>"
      msg["user"] -> msg["user"]
      true -> msg["username"] || "bot"
    end
  end

  defp resolve_user_name(token, slack_user_id) do
    case API.fetch_user_name(token, slack_user_id) do
      {:ok, name} -> name
      :error -> nil
    end
  end

  defp resolve_channel_name(token, channel) do
    case API.get("conversations.info", token, %{channel: channel}) do
      {:ok, %{"channel" => %{"name" => name}}} -> name
      _ -> channel
    end
  end

  defp present?(nil), do: false
  defp present?(""), do: false
  defp present?(_text), do: true
end
