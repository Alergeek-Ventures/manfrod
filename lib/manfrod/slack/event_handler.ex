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
  alias Manfrod.Memory.{Admin, Buffer, ChannelDetector, ChannelMapping, Classifier, Project}
  alias Manfrod.Repo
  alias Manfrod.Slack.API

  @doc """
  Handle an incoming Slack event.

  ## Supported event types

  - `"message"` — Two sub-cases:
    - **DMs**: Creates user on first interaction (DM-first). Forwards the
      text to the Agent with session scoping.
    - **Channel mentions**: Some Slack surfaces send top-level mentions as
      plain `message` events instead of `app_mention`; those are forwarded to
      the Agent.
    - **Channel thread replies**: Only forwarded if the user is known AND an
      Agent session already exists for that thread (started by any
      participant's earlier @mention, not necessarily this user's own).
      Top-level channel messages without @mention are ignored by the Agent
      path (they're still buffered for passive memory).
    - Any channel message that name-drops "manfrod" without an actual
      `<@bot_id>` @mention gets an `:eyes` reaction, independent of the
      routing above — a lightweight "I noticed" without starting a
      conversation.
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
      if not dm_channel?(channel) and not bot_mentioned?(text, bot.user_id) and
           name_dropped?(text) do
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

  def handle_event("interactive", %{"type" => "block_actions"} = payload, bot) do
    action = List.first(payload["actions"] || []) || %{}
    channel_id = get_in(payload, ["channel", "id"])
    bot_msg_ts = get_in(payload, ["message", "ts"])

    if channel_id && bot_msg_ts do
      case action["action_id"] do
        "memory_escalation_accept" ->
          Classifier.resolve_confirmation(:accept, channel_id, bot_msg_ts, bot.token)

        "memory_escalation_deny" ->
          Classifier.resolve_confirmation(:deny, channel_id, bot_msg_ts, bot.token)

        other ->
          Logger.debug("Slack EventHandler ignoring interactive action: #{inspect(other)}")
      end
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
        content: text,
        source: :slack,
        reply_to: %{channel: channel, thread_ts: thread_ts},
        ts: event["ts"],
        # A DM is unambiguous direct address — always respond.
        requires_gate: false
      },
      channel
    )
  end

  # -- Channel thread replies: only respond if bot is already in the thread ---

  defp handle_channel_mention(bot, event, raw_text, slack_user_id, channel, thread_ts) do
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
          channel_info = resolve_channel_info(bot.token, channel)
          channel_name = channel_info.name

          access_channel_id = resolve_agent_channel(event, channel, channel_name, channel_info)
          channel_context = build_channel_context(channel_name, bot.token, slack_user_id)
          content_with_context = "[#{channel_context}]\n#{cleaned_text}"

          Agent.send_message(
            user.id,
            session_key,
            %{
              content: content_with_context,
              source: :slack,
              reply_to: %{channel: channel, thread_ts: thread_ts},
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
          # Only forward if an Agent session already exists for this thread
          # (i.e. the bot was @mentioned in this thread before, by anyone —
          # not only by this specific user), so the bot doesn't barge into
          # threads it was never invited into.
          if session_exists?(session_key) do
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
                  reply_to: %{channel: channel, thread_ts: thread_ts},
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
              "Slack EventHandler ignoring channel thread reply — no active session for #{session_key}"
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
