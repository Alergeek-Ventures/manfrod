defmodule Manfrod.Agent.Server do
  @moduledoc """
  Per-session Agent GenServer.

  Each session (Slack thread) gets its own Agent process with a shared
  conversation history, inbox, and flush timer — every participant in that
  thread is handled by the same process, not one process per author. Each
  inbound message still carries its own author's identity (`user_id`,
  `readable_levels`) via its event context, so tool calls and personal data
  act on behalf of whoever actually sent the triggering message. Processes
  are started on demand and terminate after an idle timeout, triggering
  memory extraction for every participant who spoke in the session.

  ## Lifecycle

  1. Started by `Agent.send_message/3` via DynamicSupervisor
  2. Processes messages, calls LLM, broadcasts events on per-user topic
  3. On idle timeout: broadcasts `:idle` per participant, terminates normally
  4. Next message for the same session starts a fresh process
  """

  use GenServer, restart: :temporary

  require Logger

  alias Manfrod.Accounts
  alias Manfrod.Agent.Init
  alias Manfrod.Agent.PlanTitle
  alias Manfrod.Agent.ResponseGate
  alias Manfrod.Agent.TypingRefresher
  alias Manfrod.Events
  alias Manfrod.LLM
  alias Manfrod.Memory
  alias Manfrod.Memory.Access
  alias Manfrod.Memory.Soul
  alias Manfrod.Repo
  alias Manfrod.Skills

  @system_prompt_intro """
  Current date, time, and timezone are provided in the [Current Context] section.
  Use them for scheduling reminders and interpreting relative time references like
  "tomorrow", "next Monday", etc. All reminder times should be in UTC (ISO8601).
  """

  # "Your Capabilities" is generated from every discovered tool's own
  # name/description (Manfrod.Tools.capabilities_text/1) instead of a
  # hand-maintained list here — dropping a new module in lib/manfrod/tools/
  # is enough to make the agent aware of it, nothing to edit in this file.
  @system_prompt_rest """
  ## Communication style
  - Default to 1-3 short sentences. No preamble, no restating the request, no
    summarizing what you're about to do — just do it and report the outcome.
  - Don't narrate tool calls ("Let me check...", "I'll search for..."); use
    the tool and report only the result.
  - Expand only when the user explicitly asks for detail, or the answer is
    inherently a list/steps/code that can't be shortened.
  - One question at a time if you need to ask something — don't front-load
    a checklist of clarifying questions.
  - Never use an em dash or en dash (— or –). Use a plain hyphen "-" instead,
    or rewrite the sentence. This applies to every message you send.

  ## Slack threads
  - In a shared thread you are one of several participants. Answer whoever
    addressed you. If several people asked you something since your last
    reply, answer each of them, by name, in one message - never silently
    drop an earlier question in favour of the newest one.
  - An @mention with no text is a nudge: answer whatever was most recently
    said to you or asked of you in the thread.
  - If someone asks you to read or check the thread, or you are not sure
    what was said, call read_slack_thread (no arguments reads the current
    thread) instead of guessing. You always know which thread you are in.
  - When someone corrects you, accept it in a few words and use the
    corrected version from then on, spelled exactly as they wrote it. If the
    correction is about something you know from memory (e.g. why someone is
    away), save it with create_note so the mistake does not come back.
  - Never invent technical excuses about yourself ("I lost the reply",
    "single-threaded mode", "Slack did not give me the ID"). If you missed
    something, just answer it now.

  ## MANDATORY tool usage rules (NEVER skip these)

  ### Meetings
  - A meeting is confirmed → call create_note with the meeting details immediately.

  ### Reminders
  - User asks to be reminded of something → call set_reminder in the same response.

  Relevant notes are injected as a [Note context] block right before the
  messages you are answering, with their UUIDs. Use search_notes to find
  more, get_note to explore specific notes and their connections.

  Recurring reminders are linked to notes - the note content becomes your prompt
  when the reminder fires, along with all notes linked to it. Create a note with
  instructions first, then create the recurring reminder pointing to it.

  Google Calendar requires the user to have linked their Google account via the
  web app. If get_calendar_events returns a "no Google account" error, tell the
  user to sign in at the web app to connect their Google Calendar.

  Note context is scoped to your current channel's access level — you only see notes you're allowed to see in this context.

  ## Privacy

  Everything said to you in a DM is stored in that person's own private space
  (`private/<user_id>`) — the team does not see it. It only goes wider when
  that person confirms it, either by asking you to share it (use
  escalate_note) or by ticking a level on the sharing prompt the memory posts
  on its own. Never claim something told to you in a DM is visible to the
  team, and never treat one person's private notes as team knowledge.
  """

  # Tool definitions live under lib/manfrod/tools/ (one module per domain,
  # auto-discovered by Manfrod.Tools — see its moduledoc). user_id/
  # readable_levels/write_access are baked into closures at call time;
  # `msg_ctx` (%{channel, ts, thread_ts, slack_user_id}) identifies the
  # inbound Slack message so mutating tools can flag it for the passive
  # memory batch instead of writing directly, and locates the thread for
  # thread-scoped tools like leave_thread.
  defp tool_context(user_id, readable_levels, write_access, msg_ctx) do
    %{
      user_id: user_id,
      readable_levels: readable_levels,
      write_access: write_access,
      msg_ctx: msg_ctx
    }
  end

  # Client API

  def start_link({user_id, session_key, write_access, readable_levels}) do
    GenServer.start_link(__MODULE__, {user_id, session_key, write_access, readable_levels},
      name: via(session_key)
    )
  end

  @doc """
  Registry-based name for per-session Agent processes.

  Keyed by `session_key` alone (not by user) so that every participant in a
  Slack thread shares the same process/conversation — multiple authors in one
  thread are handled as one shared session, not one isolated session each.
  """
  def via(session_key) do
    {:via, Registry, {Manfrod.Agent.Registry, session_key}}
  end

  # Server Callbacks

  # Shortly after a session goes quiet its new messages go to memory
  # extraction — retrospection should run every few messages, not once an
  # hour. The process itself stays up much longer: rebuilding it costs a
  # fresh system prompt, tool list and history restore from the DB (init/1).
  @extract_delay :timer.minutes(1)
  @shutdown_delay :timer.minutes(15)

  # The [Current Context] clock in the system prompt goes stale in a
  # long-lived session; past this age it is rebuilt before the next turn.
  @system_prompt_ttl :timer.minutes(10)

  # How much of the batch being answered is used as the note-search query.
  @note_query_chars 2_000

  # How much of a session's history is replayed into a fresh process. A DM
  # thread gets all of it, with no age cutoff: it's one continuous
  # conversation with one person, and the agent is expected to remember the
  # whole thread it's replying in no matter how long the pause was. Channel
  # threads get a recent tail instead — they're multi-author, noisier, and
  # the older parts are usually irrelevant to a late reply.
  @dm_restore_limit 400
  @channel_restore_limit 60
  @channel_restore_window_hours 24

  @doc "How far back a channel thread session restores its history from the DB."
  def channel_restore_window_hours, do: @channel_restore_window_hours

  # How many recent transcript lines the response gate gets to see.
  @transcript_window 12

  # Plain (gated) thread replies wait for a short pause before the response
  # gate evaluates the batch — so someone splitting a thought across several
  # messages doesn't get judged mid-sentence. DMs and @mentions skip this
  # entirely and are processed immediately.
  @gate_debounce_delay :timer.seconds(6)

  @impl true
  def init({user_id, session_key, write_access, readable_levels}) do
    system_message = ReqLLM.Context.system(build_system_prompt(user_id, session_key))

    # Subscribe to own PubSub topic for FlushHandler-like behavior
    Events.subscribe(user_id)

    # Restore the recent history of this session from the DB. Scoped to the
    # session_key alone (not one user) so a shared multi-author thread
    # restores everyone's messages, not just the seed author's — and
    # deliberately *not* limited to messages still pending extraction: a
    # process that ended on idle timeout has had its messages folded into a
    # closed conversation, and restoring only pending ones would make the bot
    # forget a conversation the user is still in the middle of.
    restored = Memory.get_recent_session_messages(session_key, restore_opts(session_key))
    restored_messages = Enum.map(restored, &message_to_context/1)

    participants =
      restored
      |> Enum.map(& &1.user_id)
      |> MapSet.new()
      |> MapSet.put(user_id)

    unextracted =
      for %{conversation_id: nil, user_id: author} <- restored, into: MapSet.new(), do: author

    # If we restored messages, add a system notice so agent knows it restarted
    messages =
      if restored_messages != [] do
        restart_notice =
          ReqLLM.Context.user(
            "[SYSTEM] This is a continuation of an ongoing conversation — the " <>
              "#{length(restored)} messages above are its earlier history, restored " <>
              "after an idle timeout, restart, or update. Treat them as your own " <>
              "memory of this conversation: do not claim you lack context, and do " <>
              "not repeat actions already taken."
          )

        [system_message | restored_messages] ++ [restart_notice]
      else
        [system_message]
      end

    Logger.info("Agent.Server started for session #{session_key} (seed user #{user_id})")

    {:ok,
     %{
       user_id: user_id,
       session_key: session_key,
       write_access: write_access,
       readable_levels: readable_levels,
       participants: participants,
       # Authors with messages not yet handed to memory extraction.
       unextracted: unextracted,
       messages: messages,
       prompt_built_at: System.monotonic_time(:millisecond),
       # Seed the response gate's view of the thread with the restored tail,
       # so a rebuilt session judges replies in context instead of blind.
       transcript: restored |> Enum.map(&transcript_line/1) |> Enum.take(-@transcript_window),
       inbox: [],
       # Author of the turn in progress (nil when idle). A session runs one
       # turn at a time; messages arriving meanwhile wait in the inbox.
       turn: nil,
       # Set when a turn is interrupted by its own author's follow-up: the
       # next batch must be answered, never re-judged by the response gate.
       owed: false,
       # Tools and [Note context] blocks of the turn in progress, built once
       # per turn. Notes are {index, message} pairs spliced into the history
       # only when calling the model, so they never pile up in it.
       turn_tools: nil,
       turn_notes: [],
       last_ctx: nil,
       flush_timer: nil,
       shutdown_timer: Process.send_after(self(), :shutdown_idle, @shutdown_delay),
       gate_debounce_timer: nil,
       # The request the current turn is answering, kept for naming the
       # progress card (see Manfrod.Agent.PlanTitle).
       last_user_content: nil
     }}
  end

  defp restore_opts(session_key) do
    if dm_session?(session_key) do
      [limit: @dm_restore_limit, window_hours: nil]
    else
      [limit: @channel_restore_limit, window_hours: @channel_restore_window_hours]
    end
  end

  defp build_system_prompt(user_id, session_key) do
    unless Repo.healthy?() do
      full_system_prompt(user_id) <> Soul.base_prompt()
    else
      context =
        Init.build_system_prompt(user_id,
          include_events: false,
          include_git: false,
          include_samples: false
        )

      soul = Memory.get_soul(user_id)
      user = Accounts.get_user!(user_id)
      current_context = build_current_context(user, session_key)

      base =
        if soul do
          context <> "\n\n" <> full_system_prompt(user_id)
        else
          context <> "\n\n" <> full_system_prompt(user_id) <> Soul.base_prompt()
        end

      base <> "\n\n" <> current_context <> skills_catalog()
    end
  end

  # Capabilities are generated from every discovered tool's own
  # name/description (see Manfrod.Tools) rather than hand-listed here. Real
  # per-message values (readable_levels/write_access/msg_ctx) aren't known
  # yet at prompt-build time, and don't need to be — they only feed tool
  # *callbacks*, never a tool's name/description, so placeholders are safe.
  defp full_system_prompt(user_id) do
    ctx =
      tool_context(user_id, nil, nil, %{channel: nil, ts: nil, thread_ts: nil, slack_user_id: nil})

    capabilities = Manfrod.Tools.capabilities_text(ctx)

    @system_prompt_intro <>
      "\n## Your Capabilities\n" <> capabilities <> "\n\n" <> @system_prompt_rest
  end

  defp skills_catalog do
    case Skills.catalog_text() do
      nil -> ""
      text -> "\n\n" <> text
    end
  end

  @timezone "Europe/Warsaw"

  defp build_current_context(user, session_key) do
    now = DateTime.utc_now() |> DateTime.shift_zone!(@timezone)
    day_name = Calendar.strftime(now, "%A")

    {_year, week} =
      :calendar.iso_week_number({now.year, now.month, now.day})

    utc_offset_hours = div(now.utc_offset + now.std_offset, 3600)
    offset_sign = if utc_offset_hours >= 0, do: "+", else: "-"

    user_line =
      cond do
        not dm_session?(session_key) ->
          "\nThis is a shared channel thread — multiple people participate. " <>
            "Each user message is prefixed with its author " <>
            "(\"[from: Full Name <slack_id>]\" — the <slack_id> is a unique " <>
            "identifier, not part of the name; use it to tell apart people " <>
            "who share a name). Address the right person; don't assume " <>
            "there is a single \"the user\"." <> slack_location_line(session_key)

        user.name && user.name != "" ->
          "\nUser: #{user.name}"

        true ->
          ""
      end

    """
    [Current Context]
    Now: #{DateTime.to_iso8601(now)} (#{day_name})
    Week: #{week} of #{now.year}
    Timezone: #{@timezone} (#{now.zone_abbr}, UTC#{offset_sign}#{abs(utc_offset_hours)})#{user_line}
    """
    |> String.trim()
  end

  defp slack_location_line(session_key) do
    case String.split(session_key, ":", parts: 2) do
      [channel, thread_ts] ->
        "\nYou are in Slack channel #{channel}, thread_ts #{thread_ts}. " <>
          "read_slack_thread with no arguments reads this thread, " <>
          "read_slack_channel with no arguments reads this channel."

      _ ->
        ""
    end
  end

  # A DM channel ("D...") is inherently single-user, so it never has the
  # multi-author ambiguity that channel/group threads do.
  defp dm_session?(session_key) do
    case String.split(session_key, ":", parts: 2) do
      ["D" <> _ | _] -> true
      _ -> false
    end
  end

  @impl true
  def handle_cast({:message, message}, state) do
    %{content: content, source: source, reply_to: reply_to} = message
    author_user_id = Map.get(message, :user_id, state.user_id)
    readable_levels = Map.get(message, :readable_levels, state.readable_levels)
    requires_gate = Map.get(message, :requires_gate, false)

    event_ctx = %{
      user_id: author_user_id,
      readable_levels: readable_levels,
      requires_gate: requires_gate,
      session_key: state.session_key,
      meta: %{
        write_access: state.write_access,
        slack_channel_id: Map.get(reply_to || %{}, :channel)
      },
      source: source,
      reply_to: reply_to,
      slack_ts: Map.get(message, :ts)
    }

    # One event per inbound user message, before any batching/gating decides
    # whether to answer — this is the raw "someone talked to the bot" signal
    # that adoption metrics count.
    Events.broadcast(
      :message_received,
      Map.put(event_ctx, :meta, Map.put(event_ctx.meta, :content, content))
    )

    # Queue message
    state = %{
      state
      | inbox: state.inbox ++ [{content, event_ctx}],
        participants: MapSet.put(state.participants, author_user_id)
    }

    state =
      if requires_gate do
        # Plain thread reply: debounce so a burst of messages from someone
        # mid-thought gets judged as one batch once they pause, not per message.
        schedule_gate_debounce(state)
      else
        # DM or explicit @mention: unambiguous direct address, process now —
        # this also immediately drains any gated messages still waiting.
        state = cancel_gate_debounce(state)
        send(self(), :loop)
        state
      end

    {:noreply, state}
  end

  def handle_cast({:trigger_idle, event_ctx}, state) do
    Logger.info("Manual idle triggered for session #{state.session_key}")

    # Cancel any pending flush timer
    if state.flush_timer, do: Process.cancel_timer(state.flush_timer)

    # Broadcast one idle event per participant so every author's pending
    # messages get extracted, not just whoever's context happened to trigger
    # the trigger_idle call.
    broadcast_idle_for_participants(state, event_ctx)

    # Terminate - will be restarted on next message
    {:stop, :normal, state}
  end

  # Short idle: hand the new messages to memory extraction and keep going.
  # Never while a turn is still running or messages wait in the inbox.
  @impl true
  def handle_info({:flush, event_ctx}, %{turn: turn, inbox: inbox} = state)
      when not is_nil(turn) or inbox != [] do
    {:noreply, schedule_extract(state, event_ctx)}
  end

  def handle_info({:flush, event_ctx}, state) do
    Logger.info("Session #{state.session_key} idle, extracting memory")
    {:noreply, extract_pending(%{state | flush_timer: nil}, event_ctx)}
  end

  # Long idle: stop the process. The next message rebuilds it from the DB.
  def handle_info(:shutdown_idle, %{turn: turn, inbox: inbox} = state)
      when not is_nil(turn) or inbox != [] do
    {:noreply, schedule_shutdown(state)}
  end

  def handle_info(:shutdown_idle, state) do
    Logger.info("Session #{state.session_key} idle, stopping")
    state = if state.last_ctx, do: extract_pending(state, state.last_ctx), else: state
    {:stop, :normal, state}
  end

  # Ignore PubSub events we subscribe to for observability/status updates.
  # They can arrive while the server is draining inbox or calling tools.
  def handle_info({:activity, _activity}, state) do
    {:noreply, state}
  end

  # Gate debounce window elapsed with no further gated messages — process
  # whatever's queued now. (If something else already drained the inbox in
  # the meantime, this is a harmless no-op via the empty-inbox :loop clause.)
  def handle_info(:gate_debounce_elapsed, state) do
    send(self(), :loop)
    {:noreply, %{state | gate_debounce_timer: nil}}
  end

  # Loop: nothing to do
  def handle_info(:loop, %{inbox: []} = state) do
    {:noreply, state}
  end

  # Loop: a turn is already running — its end sends :loop again, and only
  # then is the inbox picked up, so two turns never interleave.
  def handle_info(:loop, %{turn: turn} = state) when not is_nil(turn) do
    {:noreply, state}
  end

  # Loop: drain inbox, decide whether to respond, start LLM call
  def handle_info(:loop, state) do
    if gate_applies?(state) and state.gate_debounce_timer != nil do
      {:noreply, state}
    else
      process_inbox(state)
    end
  end

  # LLM call: iteration limit
  def handle_info({:call_llm, ctx, iter, refresher_pid}, state) when iter >= 50 do
    stop_refresher(refresher_pid)
    Logger.error("Agent.Server: max tool iterations reached for session #{state.session_key}")

    Events.broadcast(
      :responding,
      Map.put(ctx, :meta, %{
        content: "Sorry, I got stuck working on this and had to stop. Could you try again?"
      })
    )

    send(self(), :loop)
    {:noreply, end_turn(state)}
  end

  # LLM call: check for interrupt, then call LLM
  def handle_info({:call_llm, ctx, iter, refresher_pid}, state) do
    if followed_up_by_author?(state.inbox, ctx.user_id) do
      # The author added to their own request mid-turn — restart with it in
      # context. Anyone else's message just waits for this turn to finish,
      # so one person's question can never swallow another's.
      stop_refresher(refresher_pid)
      Logger.info("Agent.Server: interrupted by new message(s) for session #{state.session_key}")
      Events.broadcast(:interrupted, ctx)
      send(self(), :loop)
      {:noreply, %{state | turn: nil, owed: true, turn_tools: nil}}
    else
      opts = [
        tools: state.turn_tools,
        purpose: :agent,
        user_id: ctx.user_id,
        session_key: state.session_key
      ]

      case call_model(opts, ctx, state) do
        {:ok, response} ->
          handle_llm_response(response, ctx, iter, refresher_pid, state)

        {:error, reason} ->
          stop_refresher(refresher_pid)
          Logger.error("LLM call failed: #{inspect(reason)}")
          error_text = "Sorry, I encountered an error: #{inspect(reason)}"

          Events.broadcast(:responding, Map.put(ctx, :meta, %{content: error_text}))
          send(self(), :loop)
          {:noreply, end_turn(state)}
      end
    end
  end

  defp gate_applies?(state) do
    not state.owed and Enum.all?(state.inbox, fn {_content, ctx} -> ctx.requires_gate end)
  end

  defp followed_up_by_author?(inbox, user_id) do
    Enum.any?(inbox, fn {_content, ctx} -> ctx.user_id == user_id end)
  end

  defp start_refresher(event_ctx) do
    case TypingRefresher.start(event_ctx.user_id, event_ctx) do
      {:ok, pid} -> pid
      {:error, _reason} -> nil
    end
  end

  defp stop_refresher(nil), do: :ok
  defp stop_refresher(pid), do: TypingRefresher.stop(pid)

  defp process_inbox(state) do
    if Repo.healthy?() do
      # The gate only applies when every message in this batch is a plain,
      # ungated thread reply and nothing is owed from an interrupted turn —
      # a DM or explicit @mention in the same batch always gets a response.
      gate_applies? = gate_applies?(state)
      prior_transcript = state.transcript
      new_contents = Enum.map(state.inbox, fn {content, _ctx} -> content end)

      # Messages are always persisted + folded into shared history, whether
      # or not the agent decides to actually reply — so the timer resets and
      # future turns have full context either way.
      {batch, event_ctx, state} = drain_inbox(state)
      state = touch(%{state | owed: false}, event_ctx)

      decision =
        if gate_applies?, do: ResponseGate.decide(prior_transcript, new_contents), else: :respond

      case decision do
        :respond ->
          {:noreply, start_turn(state, event_ctx, batch)}

        {:react, emoji} ->
          Logger.debug(
            "Agent.Server: response gate chose to react (:#{emoji}:) for session #{state.session_key}"
          )

          react(event_ctx, emoji)
          {:noreply, state}

        {:react_and_respond, emoji} ->
          Logger.debug(
            "Agent.Server: response gate chose to react (:#{emoji}:) and respond for session #{state.session_key}"
          )

          react(event_ctx, emoji)
          {:noreply, start_turn(state, event_ctx, batch)}

        :ignore ->
          Logger.debug(
            "Agent.Server: response gate declined to reply for session #{state.session_key}"
          )

          {:noreply, state}
      end
    else
      Logger.error("Agent.Server: database unavailable, cannot process message")
      {_content, event_ctx} = List.last(state.inbox)

      Events.broadcast(
        :responding,
        Map.put(event_ctx, :meta, %{
          content: "Issues with database. Need manual intervention."
        })
      )

      {:noreply, cancel_gate_debounce(%{state | inbox: [], owed: false})}
    end
  end

  defp start_turn(state, event_ctx, batch) do
    Events.broadcast(:thinking, event_ctx)

    tools =
      Manfrod.Tools.definitions(
        tool_context(
          event_ctx.user_id,
          event_ctx.readable_levels,
          state.write_access,
          msg_ctx(event_ctx)
        )
      )

    state = refresh_system_prompt(state)
    send(self(), {:call_llm, event_ctx, 0, start_refresher(event_ctx)})

    %{
      state
      | turn: event_ctx.user_id,
        turn_tools: tools,
        turn_notes: state.turn_notes ++ note_context_message(event_ctx, batch)
    }
  end

  defp end_turn(state), do: %{state | turn: nil, turn_tools: nil, turn_notes: []}

  defp note_context_message(ctx, %{index: index, text: text}) do
    project_id = Access.project_id_for_channel(ctx.meta.slack_channel_id)

    case get_note_context(ctx.user_id, ctx.readable_levels, query_tail(text), project_id) do
      "" -> []
      notes -> [{index, ReqLLM.Context.user("[Note context]\n#{notes}")}]
    end
  end

  defp query_tail(text) do
    if String.length(text) > @note_query_chars,
      do: String.slice(text, -@note_query_chars..-1//1),
      else: text
  end

  # The history the model sees: the stored conversation with this turn's
  # note blocks spliced in front of the messages they were retrieved for.
  defp llm_messages(state) do
    state.turn_notes
    |> Enum.sort_by(&elem(&1, 0), :desc)
    |> Enum.reduce(state.messages, fn {index, note}, acc -> List.insert_at(acc, index, note) end)
  end

  defp refresh_system_prompt(state) do
    age = System.monotonic_time(:millisecond) - state.prompt_built_at

    if age > @system_prompt_ttl do
      system = ReqLLM.Context.system(build_system_prompt(state.user_id, state.session_key))

      %{
        state
        | messages: [system | tl(state.messages)],
          prompt_built_at: System.monotonic_time(:millisecond)
      }
    else
      state
    end
  end

  defp react(event_ctx, emoji) do
    Events.broadcast(
      :reacted,
      Map.put(event_ctx, :meta, %{emoji: emoji, ts: event_ctx.slack_ts})
    )
  end

  # Streaming and non-streaming return the same materialized response, so the
  # rest of the loop is identical either way — only whether `:response_chunk`
  # events are emitted along the way differs. The switch exists so a provider
  # regression in streamed tool calls can be worked around in config without a
  # deploy of this module.
  defp call_model(opts, ctx, state) do
    if Application.get_env(:manfrod, :llm_streaming, true) do
      LLM.stream_text(
        llm_messages(state),
        Keyword.put(opts, :on_chunk, fn text ->
          Events.broadcast(:response_chunk, Map.put(ctx, :meta, %{text: text}))
        end)
      )
    else
      LLM.generate_text(llm_messages(state), opts)
    end
  end

  defp message_to_context(%{role: "user", content: content}) do
    ReqLLM.Context.user(content)
  end

  defp message_to_context(%{role: "assistant", content: content}) do
    ReqLLM.Context.assistant(content)
  end

  defp transcript_line(%{role: "assistant", content: content}), do: "Manfrod: #{content}"
  defp transcript_line(%{content: content}), do: content

  # Private

  # Drain all messages from inbox into the history and the DB. Returns the
  # batch (where it starts in the history and its text) for the note search
  # a turn runs if the agent ends up answering it.
  defp drain_inbox(state) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    # Persisted under each message's own author, not a fixed session owner —
    # a shared thread has messages from several people in the same inbox.
    Enum.each(state.inbox, fn {content, event_ctx} ->
      persist_message(event_ctx.user_id, %{
        role: "user",
        content: content,
        session_key: state.session_key,
        received_at: now
      })
    end)

    {_content, last_ctx} = List.last(state.inbox)
    new_contents = Enum.map(state.inbox, fn {content, _ctx} -> content end)
    authors = MapSet.new(state.inbox, fn {_content, ctx} -> ctx.user_id end)
    batch = %{index: length(state.messages), text: Enum.join(new_contents, "\n\n")}

    state =
      cancel_gate_debounce(%{
        state
        | inbox: [],
          messages: state.messages ++ Enum.map(new_contents, &ReqLLM.Context.user/1),
          transcript: Enum.take(state.transcript ++ new_contents, -@transcript_window),
          unextracted: MapSet.union(state.unextracted, authors),
          last_user_content: List.last(new_contents)
      })

    {batch, last_ctx, state}
  end

  # Schedule (or restart) the gate debounce timer — fires :gate_debounce_elapsed
  # once no further gated message has arrived for @gate_debounce_delay.
  defp schedule_gate_debounce(state) do
    if state.gate_debounce_timer, do: Process.cancel_timer(state.gate_debounce_timer)
    timer_ref = Process.send_after(self(), :gate_debounce_elapsed, @gate_debounce_delay)
    %{state | gate_debounce_timer: timer_ref}
  end

  defp cancel_gate_debounce(%{gate_debounce_timer: nil} = state), do: state

  defp cancel_gate_debounce(state) do
    Process.cancel_timer(state.gate_debounce_timer)
    %{state | gate_debounce_timer: nil}
  end

  # Restart both idle timers. Called after every processed batch (whether or
  # not the agent actually replied) and every answer, so a busy multi-author
  # thread where the agent mostly absorbs messages silently stays alive.
  defp touch(state, ctx) do
    %{state | last_ctx: ctx}
    |> schedule_extract(ctx)
    |> schedule_shutdown()
  end

  defp schedule_extract(state, ctx) do
    if state.flush_timer, do: Process.cancel_timer(state.flush_timer)
    %{state | flush_timer: Process.send_after(self(), {:flush, ctx}, @extract_delay)}
  end

  defp schedule_shutdown(state) do
    if state.shutdown_timer, do: Process.cancel_timer(state.shutdown_timer)
    %{state | shutdown_timer: Process.send_after(self(), :shutdown_idle, @shutdown_delay)}
  end

  # Extraction (Manfrod.Memory.Extractor, via FlushHandler) is scoped to a
  # single (user_id, session_key) pair, so every author with new messages
  # needs its own :idle broadcast.
  defp extract_pending(state, event_ctx) do
    Enum.each(state.unextracted, fn author ->
      Events.broadcast(:idle, Map.put(event_ctx, :user_id, author))
    end)

    %{state | unextracted: MapSet.new()}
  end

  defp record_transcript(state, line) do
    %{state | transcript: Enum.take(state.transcript ++ [line], -@transcript_window)}
  end

  # Extraction (Manfrod.Memory.Extractor, via FlushHandler) is scoped to a
  # single (user_id, session_key) pair, so a shared multi-author session needs
  # one :idle broadcast per participant to get everyone's pending messages
  # closed out — not just whoever's message happened to be "last".
  defp broadcast_idle_for_participants(state, event_ctx) do
    Enum.each(state.participants, fn participant_id ->
      Events.broadcast(:idle, Map.put(event_ctx, :user_id, participant_id))
    end)
  end

  # Handle LLM response - either tool calls or final response
  defp handle_llm_response(response, ctx, iter, refresher_pid, state) do
    case ReqLLM.Response.finish_reason(response) do
      :tool_calls ->
        # Execute tools and continue conversation
        tool_calls = ReqLLM.Response.tool_calls(response)

        Logger.info(
          "Agent.Server executing #{length(tool_calls)} tool(s) for user #{ctx.user_id}"
        )

        # The turn has become a piece of work worth showing progress for. Only
        # on the first tool-calling round: later rounds are steps within the
        # same job, not a new one.
        if iter == 0, do: announce_plan(ctx, state.last_user_content)

        # Extract any narrative text the LLM sent alongside tool calls
        narrative_text = ReqLLM.Response.text(response) || ""

        if narrative_text != "" do
          Events.broadcast(:narrating, Map.put(ctx, :meta, %{text: narrative_text}))
        end

        # Add assistant message with tool calls
        assistant_msg = ReqLLM.Context.assistant(narrative_text, tool_calls: tool_calls)
        messages = state.messages ++ [assistant_msg]

        # Execute each tool and add results
        messages_with_results =
          Enum.reduce(tool_calls, messages, fn tool_call, msgs ->
            action_id = generate_action_id()
            action_name = tool_call.function.name
            args = tool_call.function.arguments

            # Broadcast action started
            Events.broadcast(
              :action_started,
              Map.put(ctx, :meta, %{
                action_id: action_id,
                action: action_name,
                args: args
              })
            )

            # Tools were built for this turn's actual triggering author (not a
            # fixed session owner) when the turn started
            {result, duration_ms, success} = timed_execute_tool(state.turn_tools, tool_call)

            # Broadcast action completed
            Events.broadcast(
              :action_completed,
              Map.put(ctx, :meta, %{
                action_id: action_id,
                action: action_name,
                result: truncate_result(result),
                duration_ms: duration_ms,
                success: success
              })
            )

            tool_result_msg = ReqLLM.Context.tool_result(tool_call.id, action_name, result)
            msgs ++ [tool_result_msg]
          end)

        # Continue the loop
        send(self(), {:call_llm, ctx, iter + 1, refresher_pid})
        {:noreply, %{state | messages: messages_with_results}}

      _other ->
        # Final response - stop typing, persist, broadcast
        stop_refresher(refresher_pid)

        response_text =
          case ReqLLM.Response.text(response) do
            text when is_binary(text) and text != "" ->
              text

            _ ->
              Logger.warning(
                "Agent.Server got a blank final response for user #{ctx.user_id} " <>
                  "(session #{state.session_key}) after #{iter} iteration(s); " <>
                  "the model ended its turn with tool calls but no closing text"
              )

              "👍"
          end

        # Persist assistant response to DB, attributed to this turn's
        # triggering author (known v1 limitation: in a shared thread, other
        # participants' own extracted conversation won't include this reply).
        # Never let a persistence failure take down the whole session (and
        # with it, any reply to the user) — log and carry on with the
        # in-memory response instead.
        persist_message(ctx.user_id, %{
          role: "assistant",
          content: response_text,
          session_key: state.session_key,
          received_at: DateTime.utc_now() |> DateTime.truncate(:second)
        })

        # Add to conversation history
        assistant_msg = ReqLLM.Context.assistant(response_text)
        messages = state.messages ++ [assistant_msg]
        state = record_transcript(state, "Manfrod: #{response_text}")

        # Broadcast response
        Events.broadcast(:responding, Map.put(ctx, :meta, %{content: response_text}))
        Logger.info("Agent.Server broadcast response for user #{ctx.user_id} (#{ctx.source})")

        state = touch(%{state | unextracted: MapSet.put(state.unextracted, ctx.user_id)}, ctx)

        # Check for more work
        send(self(), :loop)
        {:noreply, end_turn(%{state | messages: messages})}
    end
  end

  # Name the work for the progress card, off the critical path. The card is
  # already open by the time this returns (transports show a provisional
  # title from the first tool), so this only ever renames it — which is why it
  # is fire-and-forget and silently skipped when there is nothing to name.
  defp announce_plan(_ctx, nil), do: :ok

  defp announce_plan(ctx, request) do
    Task.start(fn ->
      case PlanTitle.generate(request) do
        {:ok, title} -> Events.broadcast(:plan_titled, Map.put(ctx, :meta, %{title: title}))
        :error -> :ok
      end
    end)

    :ok
  end

  defp timed_execute_tool(tools, tool_call) do
    start_time = System.monotonic_time(:millisecond)
    {result, success} = execute_tool(tools, tool_call)
    end_time = System.monotonic_time(:millisecond)
    duration_ms = end_time - start_time

    {result, duration_ms, success}
  end

  defp execute_tool(tools, tool_call) do
    tool_name = tool_call.function.name
    args_json = tool_call.function.arguments

    case Jason.decode(args_json) do
      {:ok, args} ->
        tool = Enum.find(tools || [], &(&1.name == tool_name))

        if tool do
          run_tool(tool, args)
        else
          {"Unknown tool: #{tool_name}", false}
        end

      {:error, _} ->
        {"Failed to parse tool arguments", false}
    end
  end

  defp run_tool(tool, args) do
    case ReqLLM.Tool.execute(tool, args) do
      {:ok, result} -> {result, true}
      {:error, reason} -> {"Tool error: #{inspect(reason)}", false}
    end
  catch
    :exit, reason -> {"Tool error: #{inspect(reason)}", false}
  end

  defp generate_action_id do
    Base.encode16(:crypto.strong_rand_bytes(8), case: :lower)
  end

  defp truncate_result(result) when byte_size(result) > 500 do
    String.slice(result, 0, 497) <> "..."
  end

  defp truncate_result(result), do: result

  # Note context is an enrichment: a failing search must not take the session
  # (and the message it was about to answer) down with it.
  defp get_note_context(user_id, readable_levels, query, project_id) do
    Memory.get_note_context(user_id, readable_levels, query, project_id)
  rescue
    e ->
      Logger.error("Agent.Server: note context failed: #{Exception.message(e)}")
      ""
  catch
    :exit, reason ->
      Logger.error("Agent.Server: note context failed: #{inspect(reason)}")
      ""
  end

  defp persist_message(user_id, attrs) do
    case Memory.create_message(user_id, attrs) do
      {:ok, _message} ->
        :ok

      {:error, changeset} ->
        Logger.error(
          "Agent.Server failed to persist #{attrs.role} message for user #{user_id}: " <>
            inspect(changeset.errors)
        )
    end
  end

  # Identify the inbound Slack message for memory flagging. Only Slack messages
  # (map reply_to with a channel, plus a ts) are flaggable; other sources fall
  # back to direct writes in the mutating tools.
  defp msg_ctx(%{reply_to: %{channel: channel} = reply_to} = ctx) when is_binary(channel) do
    %{
      channel: channel,
      ts: Map.get(ctx, :slack_ts),
      # The thread the turn is happening in, as opposed to `ts` (the single
      # message that triggered it) — what `Manfrod.Tools.Kick` acts on.
      thread_ts: Map.get(reply_to, :thread_ts),
      slack_user_id: Map.get(reply_to, :slack_user_id)
    }
  end

  defp msg_ctx(_ctx), do: %{channel: nil, ts: nil, thread_ts: nil, slack_user_id: nil}
end
