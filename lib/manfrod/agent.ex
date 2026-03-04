defmodule Manfrod.Agent do
  @moduledoc """
  The Agent - a GenServer with an inbox.
  Receives messages asynchronously, thinks, acts, responds via event bus.

  ## Event-driven architecture

  The Agent broadcasts Activity events instead of calling handlers directly:
  - `:thinking` - message received, starting LLM call
  - `:narrating` - agent explaining what it's doing (text between tool calls)
  - `:action_started` - beginning action execution (tool name, args)
  - `:action_completed` - action finished (result, duration, success/fail)
  - `:responding` - final response ready
  - `:idle` - conversation timed out

  Subscribers (Slack.ActivityHandler, Memory.FlushHandler, ActivityLive) handle
  these events appropriately for their context.

  ## Message persistence

  Messages are persisted to the database immediately on receive/response.
  On idle, the FlushHandler triggers extraction which fetches pending
  messages from DB, generates a summary, and extracts facts.
  """
  use GenServer

  require Logger

  alias Manfrod.Agent.Init
  alias Manfrod.Events
  alias Manfrod.LLM
  alias Manfrod.Memory
  alias Manfrod.Repo
  alias Manfrod.Memory.Soul
  alias Manfrod.Agent.TypingRefresher
  alias Manfrod.Voyage
  alias Manfrod.Workers.TriggerWorker

  @system_prompt """
  ## Your Capabilities
  - set_reminder: Schedule a one-time reminder for yourself at a specific time
  - list_reminders: See all pending one-time reminders you have scheduled
  - cancel_reminder: Cancel a pending one-time reminder by its job ID
  - create_recurring_reminder: Create a recurring reminder on a cron schedule, linked to a note
  - list_recurring_reminders: See all recurring reminders with their schedules
  - update_recurring_reminder: Modify a recurring reminder's schedule, note, or enabled status
  - delete_recurring_reminder: Remove a recurring reminder and cancel its pending jobs
  - search_notes: Search your zettelkasten for relevant notes
  - get_note: Fetch a specific note by UUID, including linked notes
  - create_note: Add a new note to your slipbox (integrated during retrospection)
  - delete_note: Remove a note and all its links
  - link_notes: Connect two related notes
  - unlink_notes: Disconnect two notes

  Note context is injected with each message, showing relevant notes with
  their UUIDs. Use search_notes to find more, get_note to explore
  specific notes and their connections.

  Recurring reminders are linked to notes - the note content becomes your prompt
  when the reminder fires, along with all notes linked to it. Create a note with
  instructions first, then create the recurring reminder pointing to it.
  """

  # Tool definitions are created at runtime to avoid compile-time validation issues
  defp tools do
    [
      ReqLLM.Tool.new!(
        name: "set_reminder",
        description:
          "Schedule a reminder for yourself at a specific time. You will receive the message as a new conversation.",
        parameter_schema: [
          message: [type: :string, required: true, doc: "What to remind yourself about"],
          at: [
            type: :string,
            required: true,
            doc: "When to trigger (ISO8601 UTC datetime, e.g., '2026-02-04T14:00:00Z')"
          ]
        ],
        callback: &tool_set_reminder/1
      ),
      ReqLLM.Tool.new!(
        name: "list_reminders",
        description: "List all pending reminders you have scheduled.",
        parameter_schema: [],
        callback: &tool_list_reminders/1
      ),
      ReqLLM.Tool.new!(
        name: "cancel_reminder",
        description: "Cancel a pending reminder by its job ID.",
        parameter_schema: [
          id: [type: :integer, required: true, doc: "The job ID of the reminder to cancel"]
        ],
        callback: &tool_cancel_reminder/1
      ),
      ReqLLM.Tool.new!(
        name: "create_recurring_reminder",
        description:
          "Create a recurring reminder that triggers on a cron schedule. Requires a note to be linked - the note content becomes the prompt.",
        parameter_schema: [
          name: [
            type: :string,
            required: true,
            doc: "Unique identifier for the reminder (e.g., 'morning_brief', 'weekly_review')"
          ],
          cron: [
            type: :string,
            required: true,
            doc:
              "Cron expression (5 fields: minute hour day-of-month month day-of-week). Examples: '0 8 * * *' (daily at 8:00), '0 9 * * 1' (Mondays at 9:00)"
          ],
          node_id: [
            type: :string,
            required: true,
            doc: "UUID of the note containing instructions for this reminder"
          ],
          timezone: [
            type: :string,
            doc: "IANA timezone (default: 'Europe/Warsaw'). Examples: 'UTC', 'America/New_York'"
          ]
        ],
        callback: &tool_create_recurring_reminder/1
      ),
      ReqLLM.Tool.new!(
        name: "list_recurring_reminders",
        description: "List all recurring reminders with their schedules and linked notes.",
        parameter_schema: [],
        callback: &tool_list_recurring_reminders/1
      ),
      ReqLLM.Tool.new!(
        name: "update_recurring_reminder",
        description:
          "Update a recurring reminder. Can change cron schedule, linked note, timezone, or enabled status.",
        parameter_schema: [
          id: [type: :string, required: true, doc: "UUID of the recurring reminder to update"],
          cron: [type: :string, doc: "New cron expression"],
          node_id: [type: :string, doc: "UUID of new note to link"],
          timezone: [type: :string, doc: "New timezone"],
          enabled: [type: :boolean, doc: "Enable/disable the reminder"]
        ],
        callback: &tool_update_recurring_reminder/1
      ),
      ReqLLM.Tool.new!(
        name: "delete_recurring_reminder",
        description:
          "Delete a recurring reminder. All pending scheduled jobs for this reminder are cancelled.",
        parameter_schema: [
          id: [type: :string, required: true, doc: "UUID of the recurring reminder to delete"]
        ],
        callback: &tool_delete_recurring_reminder/1
      ),
      ReqLLM.Tool.new!(
        name: "search_notes",
        description:
          "Search your zettelkasten for relevant notes. Use this when you need to find facts, preferences, or context not in the initial note context.",
        parameter_schema: [
          query: [
            type: :string,
            required: true,
            doc: "Search query - what you want to find"
          ]
        ],
        callback: &tool_search_notes/1
      ),
      ReqLLM.Tool.new!(
        name: "get_note",
        description:
          "Fetch a specific note by its UUID. Also returns linked notes for context. Use when you have a note ID from the context and want more details or related notes.",
        parameter_schema: [
          id: [
            type: :string,
            required: true,
            doc: "UUID of the note to fetch (e.g., '550e8400-e29b-41d4-a716-446655440000')"
          ]
        ],
        callback: &tool_get_note/1
      ),
      ReqLLM.Tool.new!(
        name: "create_note",
        description:
          "Create a new note in your slipbox. The note will be integrated into your zettelkasten during the next retrospection cycle. Use for facts worth remembering.",
        parameter_schema: [
          content: [
            type: :string,
            required: true,
            doc: "The atomic idea or fact (1-2 sentences)"
          ]
        ],
        callback: &tool_create_note/1
      ),
      ReqLLM.Tool.new!(
        name: "delete_note",
        description:
          "Delete a note from your zettelkasten. All links to/from this note are automatically removed.",
        parameter_schema: [
          id: [
            type: :string,
            required: true,
            doc: "UUID of the note to delete"
          ]
        ],
        callback: &tool_delete_note/1
      ),
      ReqLLM.Tool.new!(
        name: "link_notes",
        description:
          "Create a link between two notes. Links are undirected - order doesn't matter.",
        parameter_schema: [
          note_a_id: [type: :string, required: true, doc: "First note UUID"],
          note_b_id: [type: :string, required: true, doc: "Second note UUID"]
        ],
        callback: &tool_link_notes/1
      ),
      ReqLLM.Tool.new!(
        name: "unlink_notes",
        description: "Remove a link between two notes.",
        parameter_schema: [
          note_a_id: [type: :string, required: true, doc: "First note UUID"],
          note_b_id: [type: :string, required: true, doc: "Second note UUID"]
        ],
        callback: &tool_unlink_notes/1
      )
    ]
  end

  # Client API

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc """
  Send a message to the agent asynchronously.

  The agent will process the message and broadcast Activity events.
  Subscribers handle response delivery based on the source.

  ## Required fields

  - `content` - the message text
  - `source` - origin atom (:telegram, :cron, :web, etc.)
  - `reply_to` - opaque reference for response routing (chat_id, pid, etc.)
  """
  def send_message(message) when is_map(message) do
    GenServer.cast(__MODULE__, {:message, message})
  end

  @doc """
  Manually trigger idle state (close conversation and extract memories).

  Used for the /idle command to let users explicitly end a conversation.
  """
  def trigger_idle(event_ctx) do
    GenServer.cast(__MODULE__, {:trigger_idle, event_ctx})
  end

  # Tool callbacks (called by ReqLLM when LLM invokes tools)

  def tool_set_reminder(%{message: message, at: at_string}) do
    with {:ok, scheduled_at, _offset} <- DateTime.from_iso8601(at_string),
         :gt <- DateTime.compare(scheduled_at, DateTime.utc_now()),
         args = %{
           prompt: "[Reminder] #{message}",
           trigger_id: "reminder_#{:erlang.phash2({message, scheduled_at})}"
         },
         {:ok, job} <- TriggerWorker.new(args, scheduled_at: scheduled_at) |> Oban.insert() do
      {:ok, "Reminder set (job ##{job.id}) for #{scheduled_at}: #{message}"}
    else
      {:error, _} -> {:ok, "Invalid datetime. Use ISO8601 UTC like '2026-02-04T14:00:00Z'"}
      :lt -> {:ok, "Cannot set reminder in the past. Provide a future datetime."}
      :eq -> {:ok, "Cannot set reminder in the past. Provide a future datetime."}
    end
  end

  def tool_list_reminders(_args) do
    import Ecto.Query

    jobs =
      Oban.Job
      |> where([j], j.worker == "Manfrod.Workers.TriggerWorker")
      |> where([j], j.state in ["scheduled", "available"])
      |> where([j], fragment("?->>'trigger_id' LIKE 'reminder_%'", j.args))
      |> order_by([j], asc: j.scheduled_at)
      |> Manfrod.Repo.all()

    if Enum.empty?(jobs) do
      {:ok, "No pending reminders."}
    else
      lines =
        Enum.map(jobs, fn job ->
          message = String.replace_prefix(job.args["prompt"], "[Reminder] ", "")
          "• ##{job.id} at #{job.scheduled_at}: #{message}"
        end)

      {:ok, "Pending reminders:\n#{Enum.join(lines, "\n")}"}
    end
  end

  def tool_cancel_reminder(%{id: job_id}) do
    # Oban.cancel_job/1 always returns :ok (idempotent)
    :ok = Oban.cancel_job(job_id)
    {:ok, "Reminder ##{job_id} cancelled."}
  end

  def tool_create_recurring_reminder(args) do
    attrs = %{
      name: args.name,
      cron: args.cron,
      node_id: args.node_id,
      timezone: Map.get(args, :timezone, "Europe/Warsaw")
    }

    case Memory.create_recurring_reminder(attrs) do
      {:ok, reminder} ->
        {:ok,
         "Created recurring reminder '#{reminder.name}' with cron '#{reminder.cron}' (#{reminder.timezone}). Linked to note: #{reminder.node_id}"}

      {:error, changeset} ->
        errors =
          Ecto.Changeset.traverse_errors(changeset, fn {msg, opts} ->
            Enum.reduce(opts, msg, fn {key, value}, acc ->
              String.replace(acc, "%{#{key}}", to_string(value))
            end)
          end)

        {:ok, "Failed to create recurring reminder: #{inspect(errors)}"}
    end
  end

  def tool_list_recurring_reminders(_args) do
    reminders = Memory.list_recurring_reminders()

    if Enum.empty?(reminders) do
      {:ok, "No recurring reminders configured."}
    else
      lines =
        Enum.map(reminders, fn r ->
          status = if r.enabled, do: "enabled", else: "disabled"
          note_preview = String.slice(r.node.content || "", 0, 50)

          "• #{r.name} (#{r.id})\n  Cron: #{r.cron} (#{r.timezone})\n  Status: #{status}\n  Note: [#{r.node_id}] #{note_preview}..."
        end)

      {:ok, "Recurring reminders:\n\n#{Enum.join(lines, "\n\n")}"}
    end
  end

  def tool_update_recurring_reminder(%{id: id} = args) do
    case Memory.get_recurring_reminder(id) do
      nil ->
        {:ok, "Recurring reminder not found: #{id}"}

      reminder ->
        # Build attrs from provided fields only
        attrs =
          args
          |> Map.drop([:id])
          |> Enum.reject(fn {_k, v} -> is_nil(v) end)
          |> Map.new()

        case Memory.update_recurring_reminder(reminder, attrs) do
          {:ok, updated} ->
            {:ok, "Updated recurring reminder '#{updated.name}'"}

          {:error, changeset} ->
            errors =
              Ecto.Changeset.traverse_errors(changeset, fn {msg, opts} ->
                Enum.reduce(opts, msg, fn {key, value}, acc ->
                  String.replace(acc, "%{#{key}}", to_string(value))
                end)
              end)

            {:ok, "Failed to update recurring reminder: #{inspect(errors)}"}
        end
    end
  end

  def tool_delete_recurring_reminder(%{id: id}) do
    case Memory.delete_recurring_reminder(id) do
      {:ok, reminder} ->
        {:ok, "Deleted recurring reminder '#{reminder.name}' and cancelled all pending jobs."}

      {:error, :not_found} ->
        {:ok, "Recurring reminder not found: #{id}"}
    end
  end

  def tool_search_notes(%{query: query}) do
    {:ok, nodes} = Memory.search(query, limit: 10)

    if Enum.empty?(nodes) do
      {:ok, "No relevant notes found for: #{query}"}
    else
      lines =
        Enum.map(nodes, fn node ->
          linked = Memory.get_node_links(node.id)
          linked_ids = Enum.map(linked, & &1.id) |> Enum.join(", ")

          if linked_ids == "" do
            "- [#{node.id}] #{node.content}"
          else
            "- [#{node.id}] #{node.content}\n  Linked to: #{linked_ids}"
          end
        end)

      {:ok, "Found #{length(nodes)} notes:\n#{Enum.join(lines, "\n")}"}
    end
  end

  def tool_get_note(%{id: id}) do
    case Memory.get_node(id) do
      nil ->
        {:ok, "Note not found: #{id}"}

      node ->
        linked_nodes = Memory.get_node_links(node.id)

        linked_content =
          if Enum.empty?(linked_nodes) do
            "No linked notes."
          else
            lines =
              Enum.map(linked_nodes, fn n ->
                "- [#{n.id}] #{n.content}"
              end)

            "Linked notes:\n#{Enum.join(lines, "\n")}"
          end

        {:ok,
         """
         Note [#{node.id}]:
         #{node.content}

         #{linked_content}
         """}
    end
  end

  def tool_create_note(%{content: content}) do
    case Voyage.embed_query(content) do
      {:ok, embedding} ->
        # Create in slipbox (processed_at: nil) - Retrospector will integrate
        case Memory.create_node(%{content: content, embedding: embedding}) do
          {:ok, node} ->
            {:ok, "Created note in slipbox: #{node.id}"}

          {:error, changeset} ->
            {:ok, "Failed to create note: #{inspect(changeset.errors)}"}
        end

      {:error, reason} ->
        {:ok, "Failed to generate embedding: #{inspect(reason)}"}
    end
  end

  def tool_delete_note(%{id: id}) do
    case Memory.delete_node(id) do
      {:ok, _node} ->
        {:ok, "Deleted note: #{id}"}

      {:error, :not_found} ->
        {:ok, "Note not found: #{id}"}
    end
  end

  def tool_link_notes(%{note_a_id: a, note_b_id: b}) do
    case Memory.create_link(a, b) do
      {:ok, _link} ->
        {:ok, "Linked #{a} <-> #{b}"}

      {:error, changeset} ->
        {:ok, "Failed to create link: #{inspect(changeset.errors)}"}
    end
  end

  def tool_unlink_notes(%{note_a_id: a, note_b_id: b}) do
    case Memory.delete_link(a, b) do
      {:ok, _link} ->
        {:ok, "Unlinked #{a} <-> #{b}"}

      {:error, :not_found} ->
        {:ok, "Link not found: #{a} <-> #{b}"}
    end
  end

  # Server Callbacks

  # 60 minutes debounce before flushing conversation
  @flush_delay :timer.minutes(60)

  @impl true
  def init(_opts) do
    system_message = ReqLLM.Context.system(build_system_prompt())

    # Restore any pending messages from DB (survives crashes/restarts)
    pending = Memory.get_pending_messages()
    restored_messages = Enum.map(pending, &message_to_context/1)

    # If we restored messages, add a system notice so agent knows it restarted
    messages =
      if restored_messages != [] do
        restart_notice =
          ReqLLM.Context.user(
            "[SYSTEM] Session was restarted (crash, update, or manual restart). " <>
              "Restored #{length(pending)} messages from conversation. " <>
              "Do not repeat actions already taken."
          )

        [system_message | restored_messages] ++ [restart_notice]
      else
        [system_message]
      end

    {:ok,
     %{
       messages: messages,
       inbox: [],
       flush_timer: nil
     }}
  end

  defp build_system_prompt do
    unless Repo.healthy?() do
      @system_prompt <> Soul.base_prompt()
    else
      context =
        Init.build_system_prompt(
          include_events: false,
          include_git: false,
          include_samples: false
        )

      soul = Memory.get_soul()

      if soul do
        # Soul exists - use context (which includes soul) + capabilities
        context <> "\n\n" <> @system_prompt
      else
        # No soul yet - trigger onboarding flow
        context <> "\n\n" <> @system_prompt <> Soul.base_prompt()
      end
    end
  end

  @impl true
  def handle_cast({:message, message}, state) do
    %{content: content, source: source, reply_to: reply_to} = message
    event_ctx = %{source: source, reply_to: reply_to}

    # Queue message and trigger loop
    state = %{state | inbox: state.inbox ++ [{content, event_ctx}]}
    send(self(), :loop)
    {:noreply, state}
  end

  def handle_cast({:trigger_idle, event_ctx}, state) do
    Logger.info("Manual idle triggered via /idle command")

    # Cancel any pending flush timer
    if state.flush_timer, do: Process.cancel_timer(state.flush_timer)

    # Broadcast idle event - FlushHandler will trigger extraction
    Events.broadcast(:idle, event_ctx)

    # Reset to fresh conversation state
    system_message = ReqLLM.Context.system(build_system_prompt())

    {:noreply,
     %{
       messages: [system_message],
       inbox: [],
       flush_timer: nil
     }}
  end

  @impl true
  def handle_info({:flush, event_ctx}, _state) do
    Logger.info("Conversation idle timeout - triggering extraction")

    # Broadcast idle event - FlushHandler will trigger extraction
    # Extractor fetches pending messages from DB
    Events.broadcast(:idle, event_ctx)

    # Reset to fresh conversation state
    # Re-build system prompt (soul may have been created during this conversation)
    system_message = ReqLLM.Context.system(build_system_prompt())

    {:noreply,
     %{
       messages: [system_message],
       inbox: [],
       flush_timer: nil
     }}
  end

  # Loop: nothing to do
  def handle_info(:loop, %{inbox: []} = state) do
    {:noreply, state}
  end

  # Loop: drain inbox, start LLM call
  def handle_info(:loop, state) do
    # Check DB health before processing
    unless Repo.healthy?() do
      Logger.error("Agent: database unavailable, cannot process message")
      # Get last event_ctx for error response
      {_content, event_ctx} = List.last(state.inbox)

      Events.broadcast(
        :responding,
        Map.put(event_ctx, :meta, %{
          content: "Issues with database. Need manual intervention."
        })
      )

      {:noreply, %{state | inbox: []}}
    else
      {messages, event_ctx, state} = drain_inbox(state)
      Events.broadcast(:thinking, event_ctx)

      # Start typing refresher
      {:ok, refresher_pid} = TypingRefresher.start(event_ctx)

      send(self(), {:call_llm, event_ctx, 0, refresher_pid})
      {:noreply, %{state | messages: messages}}
    end
  end

  # LLM call: iteration limit
  def handle_info({:call_llm, _ctx, iter, refresher_pid}, state) when iter >= 50 do
    TypingRefresher.stop(refresher_pid)
    Logger.error("Agent: max tool iterations reached")
    send(self(), :loop)
    {:noreply, state}
  end

  # LLM call: check for interrupt, then call LLM
  def handle_info({:call_llm, ctx, iter, refresher_pid}, state) do
    if state.inbox != [] do
      # Interrupted by new messages
      TypingRefresher.stop(refresher_pid)
      Logger.info("Agent: interrupted by new message(s)")
      Events.broadcast(:interrupted, ctx)
      send(self(), :loop)
      {:noreply, state}
    else
      case LLM.generate_text(state.messages, tools: tools(), purpose: :agent) do
        {:ok, response} ->
          handle_llm_response(response, ctx, iter, refresher_pid, state)

        {:error, reason} ->
          TypingRefresher.stop(refresher_pid)
          Logger.error("LLM call failed: #{inspect(reason)}")
          error_text = "Sorry, I encountered an error: #{inspect(reason)}"

          Events.broadcast(:responding, Map.put(ctx, :meta, %{content: error_text}))
          send(self(), :loop)
          {:noreply, state}
      end
    end
  end

  defp message_to_context(%{role: "user", content: content}) do
    ReqLLM.Context.user(content)
  end

  defp message_to_context(%{role: "assistant", content: content}) do
    ReqLLM.Context.assistant(content)
  end

  # Private

  # Drain all messages from inbox, persist to DB, build LLM context
  defp drain_inbox(state) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    # Build user messages with note context, persist each to DB
    {user_messages, _} =
      Enum.map_reduce(state.inbox, nil, fn {content, event_ctx}, _acc ->
        # Persist user message to DB
        {:ok, _user_msg} =
          Memory.create_message(%{
            role: "user",
            content: content,
            received_at: now
          })

        # Retrieve relevant note context
        note_context = get_note_context(content)

        # Build user message with note context prepended for LLM
        user_content =
          if note_context == "" do
            content
          else
            "[Note context]\n#{note_context}\n\n[User message]\n#{content}"
          end

        {ReqLLM.Context.user(user_content), event_ctx}
      end)

    # Get the last event_ctx for responses
    {_content, last_ctx} = List.last(state.inbox)

    messages = state.messages ++ user_messages
    {messages, last_ctx, %{state | inbox: []}}
  end

  # Handle LLM response - either tool calls or final response
  defp handle_llm_response(response, ctx, iter, refresher_pid, state) do
    case ReqLLM.Response.finish_reason(response) do
      :tool_calls ->
        # Execute tools and continue conversation
        tool_calls = ReqLLM.Response.tool_calls(response)
        Logger.info("Agent executing #{length(tool_calls)} tool(s)")

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

            # Execute and time the action
            {result, duration_ms, success} = timed_execute_tool(tool_call)

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
        TypingRefresher.stop(refresher_pid)

        response_text = ReqLLM.Response.text(response) || ""

        # Persist assistant response to DB
        {:ok, _assistant_msg} =
          Memory.create_message(%{
            role: "assistant",
            content: response_text,
            received_at: DateTime.utc_now() |> DateTime.truncate(:second)
          })

        # Add to conversation history
        assistant_msg = ReqLLM.Context.assistant(response_text)
        messages = state.messages ++ [assistant_msg]

        # Broadcast response
        Events.broadcast(:responding, Map.put(ctx, :meta, %{content: response_text}))
        Logger.info("Agent broadcast response for #{ctx.source}")

        # Debounce flush timer
        if state.flush_timer, do: Process.cancel_timer(state.flush_timer)
        timer_ref = Process.send_after(self(), {:flush, ctx}, @flush_delay)

        # Check for more work
        send(self(), :loop)
        {:noreply, %{state | messages: messages, flush_timer: timer_ref}}
    end
  end

  defp timed_execute_tool(tool_call) do
    start_time = System.monotonic_time(:millisecond)
    {result, success} = execute_tool(tool_call)
    end_time = System.monotonic_time(:millisecond)
    duration_ms = end_time - start_time

    {result, duration_ms, success}
  end

  defp execute_tool(tool_call) do
    tool_name = tool_call.function.name
    args_json = tool_call.function.arguments

    case Jason.decode(args_json) do
      {:ok, args} ->
        # Find and execute the tool
        tool = Enum.find(tools(), &(&1.name == tool_name))

        if tool do
          case ReqLLM.Tool.execute(tool, args) do
            {:ok, result} -> {result, true}
            {:error, reason} -> {"Tool error: #{inspect(reason)}", false}
          end
        else
          {"Unknown tool: #{tool_name}", false}
        end

      {:error, _} ->
        {"Failed to parse tool arguments", false}
    end
  end

  defp generate_action_id do
    Base.encode16(:crypto.strong_rand_bytes(8), case: :lower)
  end

  defp truncate_result(result) when byte_size(result) > 500 do
    String.slice(result, 0, 497) <> "..."
  end

  defp truncate_result(result), do: result

  defp get_note_context(query) do
    soul = Memory.get_soul()

    # Get notes linked to soul (workspace notes)
    linked_to_soul =
      if soul do
        Memory.get_node_links(soul.id)
      else
        []
      end

    # Semantic search for relevant notes based on user query
    relevant =
      case Memory.search(query, limit: 10) do
        {:ok, nodes} -> nodes
        _ -> []
      end

    # Combine soul + linked + relevant, deduplicated
    nodes =
      ([soul] ++ linked_to_soul ++ relevant)
      |> Enum.reject(&is_nil/1)
      |> Enum.uniq_by(& &1.id)

    Memory.build_context(nodes)
  end
end
