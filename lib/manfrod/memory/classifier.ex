defmodule Manfrod.Memory.Classifier do
  @moduledoc """
  Passive memory classifier.

  Takes a batch of Slack messages from one channel, runs them through the
  LLM classifier in a single bulk call, and dispatches the appropriate action
  for each:

  - ignore        → do nothing
  - create_memory → embed + store as memory node
  - create_absence → save fact + node at the channel's default access, then
                     post the escalation prompt proposing external/all — the
                     escalation is never applied without confirmation
  - create_meeting → store as fact with channel write_access
  - flag_sensitive → log silently, no write, no reply
  - ask_human     → save at default access immediately, then post a thread
                    reply proposing wider access; Save applies the levels the
                    person ticked, Cancel/timeout leave it at the default
                    level (nothing is lost)

  ## Default access, and the escalation prompt

  Writes take the channel's access level, except in a DM: there everything is
  written to the author's own `private/<user_id>` space. Nothing said
  one-on-one reaches the team on its own.

  Widening is proposed, never assumed. The prompt is a checkbox list of the
  levels on offer with the bot's own proposal pre-ticked (`internal` for an
  ordinary note; `internal` + `external/all` for something client-facing like
  an absence), plus Save/Cancel. The person can tick and untick freely before
  anything goes out — Save applies exactly what's ticked, Cancel keeps the
  note where it already is.
  """

  require Logger

  alias Manfrod.{Accounts, Events, Facts, LLM, Memory, Voyage}
  alias Manfrod.Memory.{Access, ChannelDetector, PendingConfirmations, PendingOps}
  alias Manfrod.Slack.API

  # Prompt content lives in priv/skills/memory/classifier.md, read at
  # runtime via Manfrod.Skills.read_prompt/1 so it can be hand-edited without
  # a recompile. Not a discoverable skill (no frontmatter) — this prompt is
  # always used in full, there's no relevance decision to make.
  defp system_prompt, do: Manfrod.Skills.read_prompt("memory/classifier.md")

  @doc """
  Classify a batch of messages from a Slack channel and dispatch actions.
  Single bulk LLM call for the entire batch.
  """
  @spec classify_batch([map()], String.t(), String.t() | nil, String.t()) :: :ok
  def classify_batch(messages, channel_id, channel_name, bot_token) do
    {:ok, write_access} = ChannelDetector.ensure_mapping(channel_id, channel_name)
    kind = resolve_kind(channel_id, channel_name, write_access)
    ensure_author_memberships(messages, channel_id)
    do_classify_batch(messages, channel_id, kind, write_access, bot_token)
  end

  # Anyone writing on a project channel is auto-enrolled as a project member,
  # so their DM/company-channel reads include the project's external levels.
  defp ensure_author_memberships(messages, channel_id) do
    case Access.get_active_mapping(channel_id) do
      %{project_id: project_id} when not is_nil(project_id) ->
        messages
        |> Enum.map(& &1["user"])
        |> Enum.uniq()
        |> Enum.each(fn slack_user_id ->
          case find_user_id(slack_user_id) do
            nil -> :ok
            user_id -> Access.ensure_membership!(user_id, project_id)
          end
        end)

      _ ->
        :ok
    end
  end

  defp resolve_kind(channel_id, channel_name, write_access) do
    case ChannelDetector.detect(channel_id, channel_name) do
      {:ok, kind, _client_id} ->
        kind

      {:error, :unmapped_channel} ->
        if Enum.any?(write_access, &String.starts_with?(&1, "external/")) do
          "project_external"
        else
          "company_channel"
        end
    end
  end

  defp do_classify_batch(messages, channel_id, kind, write_access, bot_token) do
    formatted =
      messages
      |> Enum.with_index()
      |> Enum.map(fn {msg, idx} -> "Message #{idx}:\n#{format_message(msg, kind)}" end)
      |> Enum.join("\n---\n")

    today = local_today()

    user_msg =
      "Current date: #{Date.to_iso8601(today)} (#{weekday_name(today)}).\n" <>
        "Classify each of the following #{length(messages)} message(s). " <>
        "Return a JSON array with exactly #{length(messages)} objects in the same order.\n\n" <>
        formatted

    msgs = [ReqLLM.Context.system(system_prompt()), ReqLLM.Context.user(user_msg)]

    case LLM.generate_text(msgs, purpose: :classifier) do
      {:ok, response} ->
        raw = ReqLLM.Response.text(response) || "[]"

        case parse_bulk_response(raw) do
          {:ok, results} ->
            results
            |> Enum.zip(messages)
            |> Enum.with_index()
            |> Enum.each(fn {{result, message}, idx} ->
              # Drain any op the agent flagged for this exact message. A flag
              # forces the action (agent already decided) and overrides the
              # LLM's choice; graph ops are executed verbatim afterwards.
              pending = PendingOps.take(channel_id, message["ts"])
              {action, result} = apply_pending_flag(pending.flag, result)
              reasoning = Map.get(result, "reasoning", "")
              flagged = if pending.flag, do: " (agent-flagged)", else: ""

              Logger.info(
                "Classifier [#{channel_id}] msg #{idx}: #{action}#{flagged} — #{reasoning}"
              )

              msg_access = message_write_access(channel_id, message, write_access)

              dispatch_action(action, result, message, channel_id, kind, msg_access, bot_token)
              run_ops(pending.ops)
            end)

          {:error, reason} ->
            Logger.warning(
              "Classifier bulk parse failed: #{reason} / raw: #{String.slice(raw, 0, 200)}"
            )
        end

      {:error, reason} ->
        Logger.error("Classifier LLM error: #{inspect(reason)}")
    end

    :ok
  end

  # In a DM the channel has no shared access level to inherit: the write goes
  # to the author's own private space. Resolved per message rather than per
  # batch, since access is a property of who said it, not of the channel.
  # An unknown author (not provisioned yet) falls back to the channel default
  # — nothing gets filed under a private space that has no owner.
  defp message_write_access("D" <> _ = _channel_id, message, fallback) do
    case find_user_id(message["user"]) do
      nil -> fallback
      user_id -> [Access.private_level(user_id)]
    end
  end

  defp message_write_access(_channel_id, _message, fallback), do: fallback

  # -- Action dispatch ---------------------------------------------------------

  defp dispatch_action(
         "ignore",
         _result,
         _message,
         _channel_id,
         _kind,
         _write_access,
         _bot_token
       ),
       do: :ok

  defp dispatch_action(
         "flag_sensitive",
         _result,
         message,
         channel_id,
         _kind,
         _write_access,
         _bot_token
       ) do
    Logger.warning(
      "Classifier flag_sensitive: channel=#{channel_id} user=#{message["user"]} ts=#{message["ts"]}"
    )

    Events.broadcast(:sensitive_content_detected, %{
      source: :classifier,
      meta: %{
        slack_channel_id: channel_id,
        slack_user_id: message["user"],
        ts: message["ts"]
      }
    })

    :ok
  end

  defp dispatch_action(
         "create_memory",
         result,
         message,
         channel_id,
         _kind,
         write_access,
         _bot_token
       ) do
    note = note_or_text(result, message)
    user_id = find_user_id(message["user"])

    if user_id == nil do
      Logger.debug("Classifier create_memory: skipping — user #{message["user"]} not in system")
    else
      case Voyage.embed_query(note) do
        {:ok, embedding} ->
          Memory.create_node(user_id, write_access, %{
            content: note,
            embedding: embedding,
            project_id: project_id_for_channel(channel_id)
          })

        {:error, reason} ->
          Logger.error("Classifier embed error: #{inspect(reason)}")
      end
    end

    :ok
  end

  # Absence is saved at the channel's default access — never escalated
  # automatically. Sharing to external/all always requires human confirmation
  # via the escalation buttons (node + fact are widened together on accept).
  defp dispatch_action(
         "create_absence",
         result,
         message,
         channel_id,
         kind,
         write_access,
         bot_token
       ) do
    text = message["text"] || ""
    user_name = message["user_name"] || message["user"] || "unknown"
    user_id = find_user_id(message["user"])
    {start_date, end_date} = absence_dates(result)

    if user_id && already_recorded_absence?(user_id, start_date, end_date) do
      Logger.debug("Classifier create_absence: already covered for #{user_id}, skipping")
    else
      # Fact value keeps the resolved conclusion first; the literal message stays
      # as provenance. The key carries the resolved start date, not "today".
      key = "absence:#{user_id || user_name}:#{start_date}"
      value = "#{start_date}..#{end_date} — \"#{text}\""
      Facts.set_fact(key, value, write_access, user_id)

      if user_id do
        note = note_or_text(result, message)

        case Voyage.embed_query(note) do
          {:ok, embedding} ->
            node_attrs = %{
              content: note,
              embedding: embedding,
              project_id: project_id_for_channel(channel_id)
            }

            case Memory.create_node(user_id, write_access, node_attrs) do
              {:ok, node} ->
                maybe_propose_absence_escalation(
                  channel_id,
                  kind,
                  message["ts"],
                  node,
                  key,
                  write_access,
                  bot_token,
                  lang(result)
                )

              {:error, reason} ->
                Logger.error("Classifier create_absence node error: #{inspect(reason)}")
            end

          {:error, reason} ->
            Logger.error("Classifier create_absence embed error: #{inspect(reason)}")
        end
      end
    end

    :ok
  end

  defp dispatch_action(
         "create_meeting",
         _result,
         message,
         channel_id,
         _kind,
         write_access,
         _bot_token
       ) do
    text = message["text"] || ""
    ts = message["ts"] || "0"
    key = "meeting:#{channel_id}:#{ts}"
    Facts.set_fact(key, text, write_access, "system")
    :ok
  end

  defp dispatch_action("ask_human", result, message, channel_id, kind, write_access, bot_token) do
    note = note_or_text(result, message)
    original_ts = message["ts"]
    user_id = find_user_id(message["user"])

    with {:ok, proposal} <- escalation_proposal(channel_id, kind, write_access, :note),
         {:user, uid} when not is_nil(uid) <- {:user, user_id},
         {:ok, embedding} <- Voyage.embed_query(note),
         {:ok, node} <-
           Memory.create_node(uid, write_access, %{
             content: note,
             embedding: embedding,
             project_id: project_id_for_channel(channel_id)
           }) do
      post_escalation_question(
        channel_id,
        original_ts,
        node,
        proposal,
        write_access,
        bot_token,
        lang(result)
      )
    else
      {:user, nil} ->
        Logger.debug("Classifier ask_human: skipping — user #{message["user"]} not in system")

      {:error, reason} ->
        Logger.info("Classifier ask_human skipped for #{channel_id}: #{inspect(reason)}")
    end

    :ok
  end

  defp dispatch_action(unknown, _result, _message, _channel_id, _kind, _write_access, _bot_token) do
    Logger.warning("Classifier unknown action: #{unknown}")
    :ok
  end

  defp already_recorded_absence?(user_id, start_date, end_date) do
    with {:ok, new_from} <- Date.from_iso8601(start_date),
         {:ok, new_to} <- Date.from_iso8601(end_date) do
      Facts.list_facts_by_user_unscoped("absence:", user_id)
      |> Enum.any?(fn fact ->
        with {:ok, from, to} <- Facts.parse_date_range(fact.value) do
          Date.compare(new_from, to) != :gt and Date.compare(new_to, from) != :lt
        else
          _ -> false
        end
      end)
    else
      _ -> false
    end
  end

  # -- Agent-flagged ops -------------------------------------------------------

  # No flag: use the LLM's own decision for this message.
  defp apply_pending_flag(nil, result), do: {Map.get(result, "action", "ignore"), result}

  # Flagged: force the agent's action and merge any resolved fields (dates for
  # absences, authored content for notes). The LLM-generated note is kept for
  # quality unless the agent supplied explicit content.
  defp apply_pending_flag(flag, result) do
    result =
      result
      |> maybe_override("note", Map.get(flag, :content))
      |> maybe_override("start_date", Map.get(flag, :start_date))
      |> maybe_override("end_date", Map.get(flag, :end_date))

    {flag.action, result}
  end

  defp maybe_override(result, _key, nil), do: result
  defp maybe_override(result, key, value), do: Map.put(result, key, value)

  # Execute standalone graph ops flagged by the agent. These carry the caller's
  # provenance/access so the batch stays the single execution point.
  defp run_ops(ops) do
    Enum.each(ops, fn
      {:escalate, %{node_id: id, level: level, readable_levels: rl}} ->
        Memory.escalate_note_access(id, level, rl)

      {:delete, %{node_id: id, user_id: uid}} ->
        Memory.delete_node(uid, id)

      {:link, %{a: a, b: b, user_id: uid}} ->
        Memory.create_link(uid, a, b)

      {:unlink, %{a: a, b: b, user_id: uid}} ->
        Memory.delete_link(uid, a, b)

      other ->
        Logger.warning("Classifier: unknown pending op #{inspect(other)}")
    end)
  end

  # -- Result helpers ----------------------------------------------------------

  # Reformulated third-person note from the classifier; falls back to the raw
  # message text if the model didn't provide one.
  defp note_or_text(result, message) do
    case Map.get(result, "note") do
      note when is_binary(note) and note != "" -> note
      _ -> message["text"] || ""
    end
  end

  # Language the source message was written in, as detected by the classifier
  # LLM ("pl", "en", ...). Drives which language bot-generated escalation UI
  # text is shown in. Anything other than "pl" falls back to English, since
  # that's the only other language these prompts are translated into.
  defp lang(result) do
    case Map.get(result, "lang") do
      "pl" -> :pl
      _ -> :en
    end
  end

  defp absence_dates(result) do
    today = local_today() |> Date.to_iso8601()
    start_date = valid_iso_date(result["start_date"]) || today
    end_date = valid_iso_date(result["end_date"]) || start_date
    {start_date, end_date}
  end

  defp valid_iso_date(value) when is_binary(value) do
    case Date.from_iso8601(value) do
      {:ok, _} -> value
      _ -> nil
    end
  end

  defp valid_iso_date(_), do: nil

  defp local_today do
    DateTime.now!("Europe/Warsaw") |> DateTime.to_date()
  end

  defp weekday_name(date) do
    Enum.at(
      ~w(Monday Tuesday Wednesday Thursday Friday Saturday Sunday),
      Date.day_of_week(date) - 1
    )
  end

  # Absence escalation is proposed from any channel except client channels
  # (cross-client leak risk) — never applied automatically.
  defp maybe_propose_absence_escalation(
         channel_id,
         kind,
         original_ts,
         node,
         fact_key,
         write_access,
         bot_token,
         lang
       ) do
    case escalation_proposal(channel_id, kind, write_access, :absence) do
      {:ok, proposal} ->
        post_escalation_question(
          channel_id,
          original_ts,
          node,
          proposal,
          write_access,
          bot_token,
          lang,
          fact_key: fact_key
        )

      {:error, _reason} ->
        :ok
    end
  end

  # -- Escalation proposal -----------------------------------------------------

  # What the bot offers, and what it ticks by default. `options` are the
  # levels the person may pick from; `preselected` is the bot's own proposal,
  # ticked on arrival so the common case is one click — but every box can be
  # ticked and unticked before anything is applied. Returns
  # {:ok, %{options: [level], preselected: [level]}} or {:error, reason}.
  defp escalation_proposal(_channel_id, "project_external", _write_access, _purpose),
    do: {:error, :external_channel}

  defp escalation_proposal(channel_id, kind, write_access, purpose) do
    cond do
      # DM / private space: the note is nobody's but the author's until they
      # say otherwise. `internal` is the natural next step and is ticked;
      # client-facing things (absences) additionally propose external/all.
      Access.private?(write_access) and purpose == :absence ->
        {:ok, %{options: ["internal", "external/all"], preselected: ["internal", "external/all"]}}

      Access.private?(write_access) ->
        {:ok, %{options: ["internal", "external/all"], preselected: ["internal"]}}

      purpose == :absence ->
        if "external/all" in write_access,
          do: {:error, :already_external_all},
          else: {:ok, %{options: ["external/all"], preselected: ["external/all"]}}

      true ->
        note_proposal(channel_id, kind)
    end
  end

  defp note_proposal(_channel_id, "priv_channel") do
    {:ok, %{options: ["external/all"], preselected: ["external/all"]}}
  end

  defp note_proposal(channel_id, "project_internal") do
    case Access.client_id_for_channel(channel_id) do
      nil ->
        {:error, :missing_client_mapping}

      client_id ->
        {:ok, %{options: ["external/#{client_id}"], preselected: ["external/#{client_id}"]}}
    end
  end

  defp note_proposal(_channel_id, _kind), do: {:error, :missing_client_target}

  @levels_block_id "memory_escalation_levels_block"
  @levels_action_id "memory_escalation_levels"

  defp post_escalation_question(
         channel_id,
         original_ts,
         node,
         %{options: options, preselected: preselected},
         write_access,
         bot_token,
         lang,
         opts \\ []
       ) do
    prompt =
      escalation_prompt_text(lang, node.content, current_level_text(lang, write_access))

    blocks =
      [
        levels_block(prompt, options, preselected, lang),
        %{
          type: "actions",
          elements: [
            %{
              type: "button",
              action_id: "memory_escalation_save",
              style: "primary",
              text: %{type: "plain_text", text: t(lang, :save), emoji: true}
            },
            %{
              type: "button",
              action_id: "memory_escalation_cancel",
              text: %{type: "plain_text", text: t(lang, :cancel), emoji: true}
            }
          ]
        }
      ]

    case API.post("chat.postMessage", bot_token, %{
           channel: channel_id,
           thread_ts: original_ts,
           text: prompt,
           blocks: blocks
         }) do
      {:ok, %{"ts" => bot_ts}} ->
        PendingConfirmations.put(bot_ts, channel_id, %{
          node_id: node.id,
          options: options,
          preselected: preselected,
          write_access: write_access,
          fact_key: Keyword.get(opts, :fact_key),
          lang: lang
        })

        Logger.info(
          "Classifier ask_human: posted escalation prompt on #{channel_id}/#{original_ts} " <>
            "(options: #{Enum.join(options, ", ")})"
        )

      {:error, reason} ->
        Logger.error("Classifier ask_human: failed to post: #{inspect(reason)}")
    end
  end

  defp levels_block(prompt, options, preselected, lang) do
    checkbox_options = Enum.map(options, &checkbox_option(&1, lang))

    initial =
      options
      |> Enum.filter(&(&1 in preselected))
      |> Enum.map(&checkbox_option(&1, lang))

    checkboxes =
      %{
        type: "checkboxes",
        action_id: @levels_action_id,
        options: checkbox_options
      }
      # Slack rejects an empty initial_options array — omit it entirely when
      # the bot proposes nothing by default.
      |> then(fn cb -> if initial == [], do: cb, else: Map.put(cb, :initial_options, initial) end)

    %{
      type: "section",
      block_id: @levels_block_id,
      text: %{type: "mrkdwn", text: prompt},
      accessory: checkboxes
    }
  end

  defp checkbox_option(level, lang) do
    %{
      text: %{type: "mrkdwn", text: "*#{level}*"},
      description: %{type: "mrkdwn", text: level_description(lang, level)},
      value: level
    }
  end

  defp level_description(:pl, "internal"), do: "Cały zespół Manfrod — bez klientów"

  defp level_description(:pl, "external/all"),
    do: "Zespół + wszyscy klienci (urlopy, nieobecności)"

  defp level_description(:pl, "external/" <> client), do: "Zespół + klient #{client}"
  defp level_description(:pl, level), do: level

  defp level_description(:en, "internal"), do: "The whole Manfrod team — no clients"
  defp level_description(:en, "external/all"), do: "Team + all clients (vacations, absences)"
  defp level_description(:en, "external/" <> client), do: "Team + client #{client}"
  defp level_description(:en, level), do: level

  defp current_level_text(:pl, write_access) do
    if Access.private?(write_access) do
      "tylko u Ciebie (`private`)"
    else
      "na poziomie `#{Enum.join(write_access, ", ")}`"
    end
  end

  defp current_level_text(:en, write_access) do
    if Access.private?(write_access) do
      "only visible to you (`private`)"
    else
      "at the `#{Enum.join(write_access, ", ")}` level"
    end
  end

  defp escalation_prompt_text(:pl, content, level_text) do
    "Zapisałem notatkę:\n> #{content}\n" <>
      "Teraz jest #{level_text}. Gdzie jeszcze ma trafić?"
  end

  defp escalation_prompt_text(:en, content, level_text) do
    "I saved a note:\n> #{content}\n" <>
      "It's currently #{level_text}. Where else should it go?"
  end

  defp t(:pl, :save), do: "Zapisz"
  defp t(:pl, :cancel), do: "Anuluj"
  defp t(:en, :save), do: "Save"
  defp t(:en, :cancel), do: "Cancel"

  @doc """
  Resolve an escalation prompt from a button click.

  `:save` widens the already-saved node to every level the person ticked
  (`selected_levels`, taken from the checkbox state at click time); `:cancel`
  leaves it exactly where it is. Either way the pending entry is removed and
  the prompt is replaced with the outcome, so it can't be answered twice.

  `selected_levels` is filtered against the options actually offered — a
  client can post arbitrary values, and access is never widened to a level
  this prompt didn't put on the table. Ticking nothing and pressing Save is
  the same as cancelling.
  """
  @spec resolve_escalation(:save | :cancel, [String.t()], String.t(), String.t(), String.t()) ::
          :ok
  def resolve_escalation(decision, selected_levels, channel_id, bot_ts, bot_token) do
    case PendingConfirmations.get(bot_ts) do
      {:ok, ^channel_id, %{node_id: node_id, write_access: write_access} = payload} ->
        PendingConfirmations.delete(bot_ts)

        levels =
          case decision do
            :save -> allowed_levels(selected_levels, payload)
            :cancel -> []
          end

        lang = Map.get(payload, :lang, :en)

        outcome =
          apply_escalation(levels, node_id, write_access, Map.get(payload, :fact_key), lang)

        API.post("chat.update", bot_token, %{
          channel: channel_id,
          ts: bot_ts,
          text: outcome,
          blocks: [%{type: "section", text: %{type: "mrkdwn", text: outcome}}]
        })

        :ok

      _ ->
        Logger.debug("Classifier resolve_escalation: no pending entry for #{bot_ts}")
        :ok
    end
  end

  @doc """
  Levels the bot pre-ticked for a pending prompt, or `[]` if it's unknown.

  Used as the fallback selection when a click arrives without checkbox state
  (an older prompt still in flight, or a Slack payload without `state`).
  """
  @spec preselected_levels(String.t()) :: [String.t()]
  def preselected_levels(bot_ts) do
    case PendingConfirmations.get(bot_ts) do
      {:ok, _channel_id, payload} -> Map.get(payload, :preselected, [])
      _ -> []
    end
  end

  defp allowed_levels(selected_levels, payload) do
    offered = Map.get(payload, :options, [])
    Enum.filter(selected_levels, &(&1 in offered))
  end

  defp apply_escalation([], _node_id, write_access, _fact_key, :pl) do
    "👌 OK, notatka zostaje #{current_level_text(:pl, write_access)}."
  end

  defp apply_escalation([], _node_id, write_access, _fact_key, :en) do
    "👌 OK, the note stays #{current_level_text(:en, write_access)}."
  end

  defp apply_escalation(levels, node_id, write_access, fact_key, lang) do
    # "internal" first: a node leaving a private space has to reach the team
    # before it can be widened to clients, and escalation validation enforces
    # exactly that ordering.
    {applied, failed} =
      levels
      |> Enum.sort_by(&if(&1 == "internal", do: 0, else: 1))
      |> Enum.reduce({[], []}, fn level, {applied, failed} ->
        widen_fact_access(fact_key, level)

        case Memory.escalate_note_access(node_id, level, escalation_levels(write_access, applied)) do
          {:ok, _node} ->
            {applied ++ [level], failed}

          {:error, reason} ->
            Logger.warning(
              "Classifier escalation to #{level} failed for #{node_id}: #{inspect(reason)}"
            )

            {applied, failed ++ [level]}
        end
      end)

    case {applied, failed, lang} do
      {[], _, :pl} ->
        "⚠️ Nie udało się rozszerzyć dostępu — notatka zostaje #{current_level_text(:pl, write_access)}."

      {[], _, :en} ->
        "⚠️ Couldn't widen access — the note stays #{current_level_text(:en, write_access)}."

      {applied, [], :pl} ->
        "✅ Zapisane też jako #{format_levels(applied)}."

      {applied, [], :en} ->
        "✅ Also saved as #{format_levels(applied)}."

      {applied, failed, :pl} ->
        "✅ Zapisane też jako #{format_levels(applied)}.\n" <>
          "⚠️ Nie udało się: #{format_levels(failed)}."

      {applied, failed, :en} ->
        "✅ Also saved as #{format_levels(applied)}.\n" <>
          "⚠️ Couldn't save: #{format_levels(failed)}."
    end
  end

  defp format_levels(levels), do: levels |> Enum.map(&"`#{&1}`") |> Enum.join(", ")

  # Levels the escalation is performed *from*: the node's own level plus what
  # this run has already applied. A private note carries "internal" too — its
  # owner is a team member, and reaching the team is precisely the step being
  # confirmed here. Channel notes keep their channel levels, so a client
  # channel still can't escalate anything.
  defp escalation_levels(write_access, applied) do
    base = if Access.private?(write_access), do: write_access ++ ["internal"], else: write_access
    Enum.uniq(base ++ applied)
  end

  defp widen_fact_access(nil, _target), do: :ok

  defp widen_fact_access(fact_key, target) do
    case Facts.add_access(fact_key, target) do
      {:ok, _fact} ->
        :ok

      {:error, reason} ->
        Logger.warning("Classifier widen_fact_access failed for #{fact_key}: #{inspect(reason)}")
        :ok
    end
  end

  # -- Helpers -----------------------------------------------------------------

  defp format_message(message, kind) do
    channel_type = channel_type_description(kind)
    resolved_scope = resolved_scope(kind)
    user = message["user_name"] || message["user"] || "unknown"
    text = message["text"] || ""

    """
    Channel: #{kind}
    Channel type: #{channel_type}
    Resolved scope: #{resolved_scope}
    User: #{user}
    Message: "#{text}"
    """
  end

  defp channel_type_description("project_internal"),
    do: "private project channel (team only — client cannot see this)"

  defp channel_type_description("project_external"),
    do: "shared with client (external/<client_id>)"

  defp channel_type_description("company_channel"), do: "internal company channel"
  defp channel_type_description("priv_channel"), do: "direct message / private channel (priv)"
  defp channel_type_description(_), do: "unknown"

  defp resolved_scope("priv_channel"),
    do: "private/<user_id> — the author's own space; sharing wider is confirmed by them"

  defp resolved_scope("company_channel"), do: "internal"
  defp resolved_scope("project_internal"), do: "internal"
  defp resolved_scope("project_external"), do: "internal + external/<client_id>"
  defp resolved_scope(_), do: "none"

  defp parse_bulk_response(raw) do
    cleaned =
      raw
      |> String.replace(~r/```json\s*/i, "")
      |> String.replace(~r/```/, "")
      |> String.trim()

    case Jason.decode(cleaned) do
      {:ok, list} when is_list(list) -> {:ok, list}
      {:ok, _} -> {:error, "expected JSON array, got object or scalar"}
      {:error, reason} -> {:error, inspect(reason)}
    end
  end

  defp find_user_id(nil), do: nil

  defp find_user_id(slack_user_id) do
    case Accounts.get_user_by_slack_id(slack_user_id) do
      nil -> nil
      user -> user.id
    end
  end

  # Project attribution comes straight from the channel mapping — same source
  # used to derive write_access — so a node's project is stamped at creation
  # and never depends on downstream provenance (conversation_id) that may be
  # missing.
  defp project_id_for_channel(channel_id) do
    case Access.get_active_mapping(channel_id) do
      %{project_id: project_id} -> project_id
      nil -> nil
    end
  end
end
