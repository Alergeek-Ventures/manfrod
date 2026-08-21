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
  alias Manfrod.Linear
  alias Manfrod.Memory.Access
  alias Manfrod.Memory.{Admin, Buffer, ChannelDetector, ChannelMapping, Classifier, Project}
  alias Manfrod.Repo
  alias Manfrod.Slack.API
  alias Manfrod.Slack.EventDedup
  alias Manfrod.Slack.Feedback
  alias Manfrod.Slack.Kick
  alias Manfrod.Slack.SuggestedPrompts
  alias Manfrod.Slack.ThreadPermission
  alias Manfrod.Slack.UserContext

  # Must match the shortcut's Callback ID in the Slack app config
  # (Interactivity & Shortcuts → Shortcuts → On messages).
  @kick_callback_id "kick_manfrod"

  @doc """
  Handle an incoming Slack event.

  ## Supported event types

  - `"message"` — Two sub-cases:
    - **DMs**: Creates user on first interaction (DM-first). Forwards the
      text to the Agent with session scoping.
    - **Channel mentions**: Some Slack surfaces send top-level mentions as
      plain `message` events instead of `app_mention`; those are forwarded to
      the Agent.
    - **Channel thread replies**: Only forwarded if the user is known AND the
      bot has been @mentioned somewhere in that thread (root message or any
      later reply, by anyone — see `Manfrod.Slack.ThreadPermission`). Without
      that invitation the bot never speaks in a channel thread, regardless of
      whether an Agent session happens to be alive for it.
      Top-level channel messages without @mention are ignored by the Agent
      path (they're still buffered for passive memory).
    - Any channel message that name-drops "manfrod" without an actual
      `<@bot_id>` @mention gets an `:eyes` reaction, independent of the
      routing above — a lightweight "I noticed" without starting a
      conversation.
  - `"app_mention"` — Channel @mentions. Requires user to already exist
    (must have DMed the bot first). Strips the bot mention prefix and
    includes channel context (name + user) before forwarding. A mention
    mid-thread where the bot has no live session backfills the prior thread
    messages into the new session, so the bot joins the ongoing conversation
    (shared session, gated replies from everyone) instead of starting a
    fresh exchange with the mentioning user.

  All other event types are logged at debug level and ignored.
  """
  @spec handle_event(String.t(), map(), Manfrod.Slack.Bot.t()) :: :ok
  def handle_event("message", event, bot) do
    text = event["text"]
    slack_user_id = event["user"]
    channel = event["channel"]

    if text_present?(text) and slack_user_id do
      # Before anything else: a DM is always answered, so the shimmer can go up
      # the moment the message lands rather than after the identity and channel
      # lookups below, which are several sequential Slack round trips.
      if dm_channel?(channel) do
        start_thinking(bot.token, channel, event["thread_ts"] || event["ts"])
      end

      user_name = resolve_user_name(bot.token, slack_user_id)
      channel_name = resolve_channel_name(bot.token, channel)

      # Passive memory is always active: every inbound message is buffered for
      # the Classifier (the single writer). Direct interactions additionally flow
      # to the agent, whose mutating tools only flag these buffered messages
      # instead of writing themselves — so no duplicate writes/prompts.
      Buffer.push(
        channel,
        event["thread_ts"],
        channel_name,
        %{
          "user" => slack_user_id,
          "user_name" => user_name,
          "text" => text,
          "ts" => event["ts"]
        },
        bot.token
      )

      # Name-dropped without an actual @mention ("manfrod, could you...") —
      # acknowledge with an eyes reaction without starting a full
      # conversation. Independent of the routing below, and of session state.
      # A kicked thread gets no reaction either: "stop chiming in" covers
      # emoji, not just words.
      if not dm_channel?(channel) and not bot_mentioned?(text, bot.user_id) and
           name_dropped?(text) and
           not kicked_thread?(channel, event["thread_ts"]) do
        API.add_reaction(bot.token, channel, event["ts"], "eyes")
      end

      cond do
        dm_channel?(channel) ->
          handle_dm_message(bot, event, text, slack_user_id, channel)

        bot_mentioned?(text, bot.user_id) ->
          thread_ts = event["thread_ts"] || event["ts"]
          handle_channel_mention(bot, event, text, slack_user_id, channel, thread_ts)

        true ->
          # Agent path: thread replies in active sessions (top-level channel
          # messages without @mention no-op here but are still buffered above).
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

    handle_channel_mention(bot, event, raw_text, slack_user_id, channel, thread_ts)

    :ok
  end

  # A new agent thread was opened. Slack shows the suggested prompts before
  # the user types anything, so this is the app's shop window — see
  # `Manfrod.Slack.SuggestedPrompts` for how they are chosen.
  def handle_event("assistant_thread_started", %{"assistant_thread" => thread}, bot) do
    slack_user_id = thread["user_id"]
    channel_id = thread["channel_id"]

    # The thread's own context is fresher than anything cached — record it
    # before building prompts that may refer to it.
    UserContext.put(slack_user_id, thread["context"])

    suggest_prompts(bot, slack_user_id, channel_id, thread["thread_ts"])

    :ok
  end

  def handle_event("app_home_opened", %{"user" => slack_user_id} = event, bot) do
    UserContext.put(slack_user_id, event["app_context"])

    # Only the Messages tab has a composer to pin prompts above; the Home tab
    # is a different surface with no thread to attach them to.
    if event["tab"] in [nil, "messages"] do
      suggest_prompts(bot, slack_user_id, event["channel"], event["thread_ts"])
    end

    :ok
  end

  # The user navigated somewhere else while the app was open. Recorded so a DM
  # like "streść mi to" has a referent — see `Manfrod.Slack.UserContext`.
  def handle_event("app_context_changed", %{"user" => slack_user_id} = event, _bot) do
    UserContext.put(slack_user_id, event["app_context"])
    :ok
  end

  def handle_event("slash_commands", %{"command" => "/status-manfrod"} = payload, bot) do
    channel_id = payload["channel_id"]
    slack_user_id = payload["user_id"]

    text =
      if admin_slack_user?(slack_user_id) do
        handle_status_command(payload, bot.token)
      else
        "Tylko admin może używać `/status-manfrod`."
      end

    API.post("chat.postMessage", bot.token, %{channel: channel_id, text: text})
    :ok
  end

  def handle_event("slash_commands", %{"command" => "/add-user"} = payload, bot) do
    channel_id = payload["channel_id"]
    slack_user_id = payload["user_id"]

    text =
      if admin_slack_user?(slack_user_id) do
        handle_add_user_command(payload, bot.token)
      else
        "Tylko admin może używać `/add-user`."
      end

    API.post("chat.postMessage", bot.token, %{channel: channel_id, text: text})
    :ok
  end

  def handle_event("slash_commands", %{"command" => "/linear-status"} = payload, bot) do
    channel_id = payload["channel_id"]

    case Access.get_active_mapping(channel_id) do
      %{project: %Project{} = project} ->
        Linear.Status.post_status(bot.token, channel_id, payload["user_id"], project)

      _ ->
        API.post("chat.postEphemeral", bot.token, %{
          channel: channel_id,
          user: payload["user_id"],
          text: "`/linear-status` działa tylko na kanałach zmapowanych do projektu."
        })
    end

    :ok
  end

  # view_submission for the /linear-status "Connect" modal — see
  # Manfrod.Linear.Status for why this always closes the modal rather than
  # returning a synchronous `response_action: "errors"`.
  def handle_event(
        "interactive",
        %{"type" => "view_submission", "view" => %{"callback_id" => "linear_connect_modal"}} =
          payload,
        bot
      ) do
    project_id = get_in(payload, ["view", "private_metadata"])

    api_key =
      get_in(payload, ["view", "state", "values", "api_key_block", "api_key_input", "value"])

    slack_user_id = get_in(payload, ["user", "id"])

    Linear.Status.handle_connect_submission(bot.token, project_id, slack_user_id, api_key)

    :ok
  end

  # "Wyrzuć Manfroda" — a message shortcut rather than a slash command,
  # because Slack refuses to run app slash commands inside threads at all
  # (and their payload carries no thread_ts). A message action is the only
  # surface that both works in a thread and says which thread it means.
  def handle_event(
        "interactive",
        %{"type" => "message_action", "callback_id" => @kick_callback_id} = payload,
        bot
      ) do
    channel = get_in(payload, ["channel", "id"])
    message = payload["message"] || %{}
    slack_user_id = get_in(payload, ["user", "id"])

    # Set on a reply; absent when the shortcut is used on the thread's root
    # message, where the root's own ts is the thread id.
    thread_ts = message["thread_ts"] || message["ts"]

    kick_thread(bot, channel, thread_ts, slack_user_id, "shortcut")

    :ok
  end

  def handle_event("interactive", %{"type" => "block_actions"} = payload, bot) do
    action = List.first(payload["actions"] || []) || %{}
    channel_id = get_in(payload, ["channel", "id"])
    bot_msg_ts = get_in(payload, ["message", "ts"])
    trigger_id = payload["trigger_id"]

    case action["action_id"] do
      "linear_connect" ->
        Linear.Status.open_connect_modal(
          bot.token,
          trigger_id,
          action["value"],
          payload["response_url"]
        )

      "linear_disconnect" ->
        project_id = action["value"]
        Linear.disconnect(project_id)

        case Repo.get(Project, project_id) do
          nil -> :ok
          project -> Linear.Status.refresh(payload["response_url"], project)
        end

      other_or_nil ->
        if channel_id && bot_msg_ts do
          case other_or_nil do
            "manfrod_feedback" ->
              Feedback.record(payload, action, bot.token)

            "manfrod_feedback_remove" ->
              Feedback.remove(payload, bot.token)

            "memory_escalation_save" ->
              levels = selected_escalation_levels(payload, bot_msg_ts)
              Classifier.resolve_escalation(:save, levels, channel_id, bot_msg_ts, bot.token)

            "memory_escalation_cancel" ->
              Classifier.resolve_escalation(:cancel, [], channel_id, bot_msg_ts, bot.token)

            # Ticking a checkbox is not a decision — the prompt stays open until
            # Save or Cancel. Slack still delivers it, so swallow it quietly.
            "memory_escalation_levels" ->
              :ok

            other ->
              Logger.debug("Slack EventHandler ignoring interactive action: #{inspect(other)}")
          end
        end
    end

    :ok
  end

  def handle_event(type, _event, _bot) do
    Logger.debug("Slack EventHandler ignoring event type: #{type}")
    :ok
  end

  defp kicked_thread?(channel, thread_ts) when is_binary(thread_ts),
    do: ThreadPermission.kicked?(channel, thread_ts)

  defp kicked_thread?(_channel, _thread_ts), do: false

  # Shared by the message shortcut above and, via `Manfrod.Tools.Kick`, by the
  # agent asking to leave. The Manfrod account is looked up but not required:
  # anyone in the thread may evict the bot, including someone who has never
  # DMed it.
  defp kick_thread(bot, channel, thread_ts, slack_user_id, source)
       when is_binary(channel) and is_binary(thread_ts) do
    user = slack_user_id && Accounts.get_user_by_slack_id(slack_user_id)

    attrs = %{
      user_id: user && user.id,
      slack_user_id: slack_user_id,
      source: source
    }

    case Kick.run(bot.token, channel, thread_ts, attrs) do
      :already_kicked ->
        # Don't post a second farewell into a thread already left — tell only
        # the person who clicked, so the thread stays quiet.
        API.post("chat.postEphemeral", bot.token, %{
          channel: channel,
          thread_ts: thread_ts,
          user: slack_user_id,
          text: "Już mnie tu nie ma — oznacz mnie `@Manfrod`, jeśli mam wrócić."
        })

        :ok

      other ->
        other
    end
  end

  defp kick_thread(_bot, channel, thread_ts, _slack_user_id, _source) do
    Logger.warning(
      "Slack EventHandler: kick without a thread (channel=#{inspect(channel)}, " <>
        "thread_ts=#{inspect(thread_ts)})"
    )

    :ok
  end

  @escalation_levels_block "memory_escalation_levels_block"
  @escalation_levels_action "memory_escalation_levels"

  # Which access levels were ticked when Save was pressed. Slack ships the
  # whole message's input state with every block_actions payload, so the
  # checkbox selection arrives on the button click itself. A payload without
  # state (an older prompt, an unexpected shape) falls back to what the bot
  # had pre-ticked — never to "everything on offer".
  defp selected_escalation_levels(payload, bot_msg_ts) do
    case get_in(payload, [
           "state",
           "values",
           @escalation_levels_block,
           @escalation_levels_action,
           "selected_options"
         ]) do
      options when is_list(options) ->
        Enum.flat_map(options, fn
          %{"value" => value} when is_binary(value) -> [value]
          _ -> []
        end)

      _ ->
        Classifier.preselected_levels(bot_msg_ts)
    end
  end

  # -- DM messages: create user on first interaction, forward to Agent ---------

  defp handle_dm_message(bot, event, text, slack_user_id, channel) do
    thread_ts = event["thread_ts"] || event["ts"]
    session_key = "#{channel}:#{thread_ts}"

    {name, email} =
      case API.fetch_user_info(bot.token, slack_user_id) do
        {:ok, %{name: name, email: email}} -> {name, email}
        :error -> {nil, nil}
      end

    {:ok, user} = Accounts.find_or_create_by_slack_id(slack_user_id, channel, name, email)

    Agent.send_message(
      user.id,
      session_key,
      %{
        content: with_viewing_context(text, bot.token, slack_user_id),
        source: :slack,
        reply_to: %{channel: channel, thread_ts: thread_ts, slack_user_id: slack_user_id},
        ts: event["ts"],
        # A DM is unambiguous direct address — always respond.
        requires_gate: false
      },
      channel
    )
  end

  # Prefix a DM with where the user is looking, when Slack has told us. Only
  # DMs get this: in a channel thread the referent of "this" is the thread the
  # message is already in, and prepending a different channel would confuse it.
  defp with_viewing_context(text, bot_token, slack_user_id) do
    case UserContext.describe(slack_user_id, &resolve_channel_name(bot_token, &1)) do
      nil -> text
      description -> "[#{description}]\n#{text}"
    end
  end

  # Fire-and-forget: this exists to make the bot look responsive, so it must
  # not itself add a round trip to the path it is trying to shorten. The
  # status is cleared again once the reply starts streaming — see
  # `Manfrod.Slack.StreamSession`.
  defp start_thinking(bot_token, channel, thread_ts) do
    Task.start(fn -> API.set_status(bot_token, channel, thread_ts, "is thinking...") end)
    :ok
  end

  defp suggest_prompts(bot, slack_user_id, channel_id, thread_ts)
       when is_binary(slack_user_id) and is_binary(channel_id) do
    user = Accounts.get_user_by_slack_id(slack_user_id)
    prompts = SuggestedPrompts.build(user, slack_user_id, &resolve_channel_name(bot.token, &1))

    case API.set_suggested_prompts(bot.token, channel_id, thread_ts, prompts) do
      {:ok, _body} ->
        :ok

      {:error, reason} ->
        Logger.debug(
          "Slack EventHandler could not set suggested prompts in #{channel_id}: #{inspect(reason)}"
        )
    end
  end

  defp suggest_prompts(_bot, _slack_user_id, _channel_id, _thread_ts), do: :ok

  # -- Channel thread replies: only respond if bot is already in the thread ---

  # A single @mention arrives as two Slack events (`message` + `app_mention`),
  # and Socket Mode can redeliver either — without this guard each delivery
  # would reach the Agent and the bot would reply twice to one message.
  defp handle_channel_mention(bot, event, raw_text, slack_user_id, channel, thread_ts) do
    if EventDedup.first?({:mention, channel, event["ts"]}) do
      # An explicit @mention is always answered, so — as with a DM — the
      # shimmer goes up now, ahead of the lookups and the thread backfill.
      # Inside the dedup guard, or the duplicate `message`/`app_mention`
      # delivery of one mention would set it twice.
      start_thinking(bot.token, channel, thread_ts)

      do_handle_channel_mention(bot, event, raw_text, slack_user_id, channel, thread_ts)
    else
      Logger.debug(
        "Slack EventHandler ignoring duplicate mention delivery for #{channel}/#{event["ts"]}"
      )
    end
  end

  defp do_handle_channel_mention(bot, event, raw_text, slack_user_id, channel, thread_ts) do
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

          # Ephemeral in a kicked thread: the person still needs to hear why
          # they got no answer, but a thread the bot was thrown out of is not
          # a place for it to post — and their mention did not lift the kick,
          # since only a known user's mention does that.
          if kicked_thread?(channel, thread_ts) do
            API.post("chat.postEphemeral", bot.token, %{
              channel: channel,
              thread_ts: thread_ts,
              user: slack_user_id,
              text: "DM me first to get started!"
            })
          else
            API.post("chat.postMessage", bot.token, %{
              channel: channel,
              thread_ts: thread_ts,
              text: "DM me first to get started!"
            })
          end

        user ->
          # An explicit @mention invites the bot into this thread for good —
          # from now on it may also answer plain replies here.
          ThreadPermission.allow(channel, thread_ts)

          channel_info = resolve_channel_info(bot.token, channel)
          channel_name = channel_info.name

          access_channel_id = resolve_agent_channel(event, channel, channel_name, channel_info)
          channel_context = build_channel_context(channel_name, bot.token, slack_user_id)
          history_block = maybe_thread_history(bot, event, channel, thread_ts, session_key)
          content_with_context = history_block <> "[#{channel_context}]\n#{cleaned_text}"

          Agent.send_message(
            user.id,
            session_key,
            %{
              content: content_with_context,
              source: :slack,
              reply_to: %{channel: channel, thread_ts: thread_ts, slack_user_id: slack_user_id},
              ts: event["ts"],
              # An explicit @mention is unambiguous direct address — always respond.
              requires_gate: false
            },
            access_channel_id
          )
      end
    else
      Logger.debug("Slack EventHandler ignoring mention with no text after stripping mention")
    end
  end

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
          # Only forward if the bot was @mentioned somewhere in this thread
          # (by anyone — not only by this specific user), so it never barges
          # into a thread it was not invited into. Deliberately not keyed on
          # a live Agent session: sessions die on idle timeout, and proactive
          # or cron posts can create one in a thread nobody invited it to.
          if ThreadPermission.allowed?(bot, channel, thread_ts) do
            # Strip bot mention if present (user might @mention again in the thread)
            cleaned_text =
              text
              |> String.replace(~r/<@#{Regex.escape(bot.user_id)}>/, "")
              |> String.trim()

            if text_present?(cleaned_text) do
              channel_info = resolve_channel_info(bot.token, channel)
              channel_name = channel_info.name

              access_channel_id =
                resolve_agent_channel(event, channel, channel_name, channel_info)

              tagged_text = tag_author(cleaned_text, user.name, slack_user_id)

              Agent.send_message(
                user.id,
                session_key,
                %{
                  content: tagged_text,
                  source: :slack,
                  reply_to: %{
                    channel: channel,
                    thread_ts: thread_ts,
                    slack_user_id: slack_user_id
                  },
                  ts: event["ts"],
                  # Plain thread reply, no @mention — goes through the
                  # response gate instead of always triggering a reply.
                  requires_gate: true
                },
                access_channel_id
              )
            end
          else
            Logger.debug(
              "Slack EventHandler ignoring channel thread reply — bot not @mentioned in #{session_key}"
            )
          end
      end
    else
      Logger.debug("Slack EventHandler ignoring top-level channel message without @mention")
    end
  end

  defp session_exists?(session_key) do
    Registry.lookup(Manfrod.Agent.Registry, session_key) != []
  end

  @thread_history_limit 50

  # An @mention mid-thread where no Agent session exists yet means the bot is
  # being pulled into a conversation that started without it. Backfill the
  # prior thread messages into the new session's first message so the agent
  # joins with the same context as if it had been present from the start —
  # not as a fresh one-on-one exchange with whoever mentioned it. Mentions at
  # the thread root, or in threads with a live session, have nothing to
  # backfill.
  defp maybe_thread_history(bot, event, channel, thread_ts, session_key) do
    if event["thread_ts"] != nil and not session_exists?(session_key) do
      case API.list_thread_replies(bot.token, channel, thread_ts, limit: @thread_history_limit) do
        {:ok, messages} ->
          format_thread_history(bot, messages, event["ts"])

        {:error, reason} ->
          Logger.warning(
            "Slack EventHandler: failed to backfill thread history for #{session_key}: " <>
              inspect(reason)
          )

          ""
      end
    else
      ""
    end
  end

  defp format_thread_history(bot, messages, mention_ts) do
    prior = Enum.reject(messages, &(&1["ts"] == mention_ts))
    names = resolve_history_authors(bot, prior)

    lines =
      for msg <- prior, text_present?(msg["text"]) do
        "#{history_author(bot, msg, names)}: #{msg["text"]}"
      end

    if lines == [] do
      ""
    else
      "[Thread history — you were just mentioned in an ongoing thread. " <>
        "These messages were sent before you joined:]\n" <>
        Enum.join(lines, "\n") <> "\n[End of thread history]\n"
    end
  end

  defp resolve_history_authors(bot, messages) do
    messages
    |> Enum.map(& &1["user"])
    |> Enum.reject(&(is_nil(&1) or &1 == bot.user_id))
    |> Enum.uniq()
    |> Map.new(fn slack_user_id ->
      {slack_user_id, resolve_user_name(bot.token, slack_user_id)}
    end)
  end

  defp history_author(bot, msg, names) do
    cond do
      msg["user"] == bot.user_id -> "Manfrod"
      msg["user"] -> format_author(names[msg["user"]], msg["user"])
      true -> msg["username"] || "bot"
    end
  end

  defp tag_author(text, author_name, slack_user_id) do
    "[from: #{format_author(author_name, slack_user_id)}]\n#{text}"
  end

  # Full name + Slack ID, not just the name — two people can share a first
  # name (or even a full name), but the Slack ID is always unique.
  defp format_author(nil, slack_user_id), do: slack_user_id
  defp format_author(author_name, slack_user_id), do: "#{author_name} <#{slack_user_id}>"

  defp bot_mentioned?(text, bot_user_id) when is_binary(text) and is_binary(bot_user_id) do
    String.contains?(text, "<@#{bot_user_id}>")
  end

  defp bot_mentioned?(_text, _bot_user_id), do: false

  @bot_name_pattern ~r/\bmanfrod\b/i

  defp name_dropped?(text) when is_binary(text), do: Regex.match?(@bot_name_pattern, text)
  defp name_dropped?(_text), do: false

  defp dm_channel?("D" <> _), do: true
  defp dm_channel?(_), do: false

  defp text_present?(nil), do: false
  defp text_present?(""), do: false
  defp text_present?(_text), do: true

  defp build_channel_context(channel_name, token, slack_user_id) do
    user_name = resolve_user_name(token, slack_user_id)

    parts = [
      "Slack channel: ##{channel_name}",
      "from: #{format_author(user_name, slack_user_id)}"
    ]

    Enum.join(parts, ", ")
  end

  defp resolve_agent_channel(event, channel, channel_name, channel_info) do
    if private_conversation?(event, channel, channel_info) do
      nil
    else
      {:ok, _write_access} = ChannelDetector.ensure_mapping(channel, channel_name)
      channel
    end
  end

  defp private_conversation?(_event, "D" <> _, _channel_info), do: true

  defp private_conversation?(%{"channel_type" => channel_type}, _channel, _channel_info)
       when channel_type in ["im", "mpim"],
       do: true

  defp private_conversation?(_event, _channel, %{is_im: true}), do: true
  defp private_conversation?(_event, _channel, %{is_mpim: true}), do: true
  defp private_conversation?(_event, _channel, _channel_info), do: false

  defp resolve_channel_info(token, channel) do
    case API.get("conversations.info", token, %{channel: channel}) do
      {:ok, %{"channel" => info}} ->
        %{
          name: Map.get(info, "name") || channel,
          is_im: Map.get(info, "is_im") == true,
          is_mpim: Map.get(info, "is_mpim") == true
        }

      _ ->
        %{name: channel, is_im: dm_channel?(channel), is_mpim: false}
    end
  end

  defp resolve_channel_name(token, channel) do
    resolve_channel_info(token, channel).name
  end

  defp resolve_user_name(token, slack_user_id) do
    case API.fetch_user_name(token, slack_user_id) do
      {:ok, name} -> name
      :error -> nil
    end
  end

  defp admin_slack_user?(slack_user_id) do
    admin_emails = Application.get_env(:manfrod, :admin_emails, [])

    case Accounts.get_user_by_slack_id(slack_user_id) do
      %{email: email} when is_binary(email) -> email in admin_emails
      _ -> false
    end
  end

  defp handle_status_command(payload, bot_token) do
    text = String.trim(payload["text"] || "")

    case String.split(text, ~r/\s+/, trim: true) do
      ["map", "company"] ->
        map_company_channel(payload, bot_token)

      ["map", project_slug] ->
        map_current_channel(payload, bot_token, project_slug, nil)

      ["map", project_slug, client_id] ->
        map_current_channel(payload, bot_token, project_slug, client_id)

      [] ->
        build_channel_mapping_status(bot_token)

      _ ->
        "Użycie: `/status-manfrod`, `/status-manfrod map company` " <>
          "albo `/status-manfrod map <project_slug> [client_id]`."
    end
  end

  # Company channel: no project, no client — writes internal, reads include
  # the caller's project external levels (resolved per user at query time).
  defp map_company_channel(payload, bot_token) do
    channel_id = payload["channel_id"]
    channel_name = payload["channel_name"] || resolve_channel_name(bot_token, channel_id)
    user = Accounts.get_user_by_slack_id(payload["user_id"])

    attrs = %{
      slack_channel_id: channel_id,
      slack_channel_name: channel_name,
      project_id: nil,
      client_id: nil,
      source: "slack_command",
      status: "active",
      set_by_user_id: user && user.id
    }

    result =
      case Repo.get_by(ChannelMapping, slack_channel_id: channel_id) do
        nil -> Admin.create_channel_mapping(attrs)
        mapping -> Admin.update_channel_mapping(mapping, attrs)
      end

    case result do
      {:ok, _mapping} ->
        "Zmapowano ##{channel_name} jako kanał firmowy (`internal`)."

      {:error, changeset} ->
        "Nie udało się zapisać mappingu: #{inspect(changeset.errors)}"
    end
  end

  defp map_current_channel(payload, bot_token, project_slug, client_id) do
    channel_id = payload["channel_id"]
    channel_name = payload["channel_name"] || resolve_channel_name(bot_token, channel_id)
    slack_user_id = payload["user_id"]
    user = Accounts.get_user_by_slack_id(slack_user_id)

    case Repo.get_by(Project, slug: project_slug) do
      nil ->
        "Nie ma projektu `#{project_slug}`. Utwórz go najpierw w `/admin/access`."

      project ->
        attrs = %{
          slack_channel_id: channel_id,
          slack_channel_name: channel_name,
          project_id: project.id,
          client_id: normalize_client_id(client_id),
          source: "slack_command",
          status: "active",
          set_by_user_id: user && user.id
        }

        result =
          case Repo.get_by(ChannelMapping, slack_channel_id: channel_id) do
            nil -> Admin.create_channel_mapping(attrs)
            mapping -> Admin.update_channel_mapping(mapping, attrs)
          end

        case result do
          {:ok, mapping} ->
            access =
              if mapping.client_id,
                do: "internal + external/#{mapping.client_id}",
                else: "internal"

            "Zmapowano ##{channel_name} -> `#{project_slug}` (`#{access}`)."

          {:error, changeset} ->
            "Nie udało się zapisać mappingu: #{inspect(changeset.errors)}"
        end
    end
  end

  # -- /add-user: provision a user without requiring them to DM first ---------

  @add_user_usage "Użycie: `/add-user @osoba email@domena.pl`"

  defp handle_add_user_command(payload, bot_token) do
    text = String.trim(payload["text"] || "")

    case parse_add_user_args(text) do
      {:ok, target_id, email} ->
        case Accounts.get_user_by_slack_id(target_id) do
          %{} = existing ->
            "<@#{target_id}> już jest w bazie " <>
              "(#{existing.name || "bez imienia"}, #{existing.email || "bez maila"})."

          nil ->
            provision_user(bot_token, target_id, email)
        end

      :error ->
        @add_user_usage <>
          " — oznacz osobę prawdziwym @mention i podaj adres email. " <>
          "Jeśli mention nie jest rozpoznawany, włącz \"Escape channels, users, " <>
          "and links\" w konfiguracji komendy w Slack."
    end
  end

  # Slash-command text with escaping enabled delivers mentions as
  # "<@U123|handle>" (or "<@U123>"); the email is matched anywhere in the rest.
  defp parse_add_user_args(text) do
    with [_, target_id] <- Regex.run(~r/<@([A-Z0-9]+)(?:\|[^>]*)?>/, text),
         [email] <- Regex.run(~r/[\w.+-]+@[\w-]+\.[\w.-]+/, text) do
      {:ok, target_id, email}
    else
      _ -> :error
    end
  end

  # The users table requires slack_dm_channel_id (DM-first invariant), so a
  # user added by command gets their DM channel opened up front via
  # conversations.open — after this they're indistinguishable from a user who
  # DMed the bot themselves.
  defp provision_user(bot_token, target_id, email) do
    name =
      case API.fetch_user_info(bot_token, target_id) do
        {:ok, %{name: name}} -> name
        :error -> nil
      end

    case API.open_dm(bot_token, target_id) do
      {:ok, dm_channel_id} ->
        case Accounts.find_or_create_by_slack_id(target_id, dm_channel_id, name, email) do
          {:ok, user} ->
            "Dodałem <@#{target_id}> (#{user.name || "bez imienia"}, #{user.email}) do bazy."

          {:error, changeset} ->
            "Nie udało się dodać użytkownika: #{inspect(changeset.errors)}"
        end

      {:error, reason} ->
        "Nie udało się otworzyć DM z <@#{target_id}> (#{inspect(reason)}) — nie dodałem."
    end
  end

  defp normalize_client_id(nil), do: nil
  defp normalize_client_id("-"), do: nil
  defp normalize_client_id("internal"), do: nil
  defp normalize_client_id(client_id), do: client_id

  defp build_channel_mapping_status(_bot_token) do
    import Ecto.Query

    mappings =
      Repo.all(from cm in ChannelMapping, order_by: [asc: cm.status, asc: cm.slack_channel_name])

    if mappings == [] do
      "*Manfrod — mapowania kanałów*\n\nBrak zmapowanych kanałów. Kanały `av-x-*` są wykrywane automatycznie."
    else
      lines =
        Enum.map(mappings, fn cm ->
          status_icon = if cm.status == "active", do: "🟢", else: "🟡"
          access = if cm.client_id, do: "internal + external/#{cm.client_id}", else: "internal"
          "#{status_icon} *##{cm.slack_channel_name}* → `#{access}` (#{cm.source})"
        end)

      "*Manfrod — mapowania kanałów*\n\n" <>
        Enum.join(lines, "\n") <>
        "\n\nZarządzaj przez `/admin/access` w panelu webowym."
    end
  end
end
