defmodule Manfrod.Slack.StreamSession do
  @moduledoc """
  One streaming Slack message, for the duration of one agent turn.

  A turn can take a long time — several LLM round trips with tool calls in
  between — and until this existed the user saw nothing at all until the very
  end. A session opens a `chat.startStream` message on the first thing worth
  showing and then keeps it updated in place: the answer as it is generated,
  and the work being done alongside it.

  ## The progress card

  The stream runs in `task_display_mode: "plan"`, so the tool calls do not
  appear as a loose list of cards — they are grouped into one card named after
  the job (`plan/3`, from `Manfrod.Agent.PlanTitle`), with each tool call a
  step inside it (`task/3`). The card spins until the stream stops, which is
  why `finish/4` force-completes anything still open: a step left
  `in_progress` would leave the card looking stuck forever.

  ## Lifecycle

      ensure_started/4       lazily; no Slack call yet
      plan/3, text/3, task/3 first one opens the stream, later ones append
      finish/4               appends the tail + feedback buttons, stops the stream

  The stream is opened lazily rather than on `ensure_started/4` so that a turn
  which produces nothing (the response gate declining to answer, an immediate
  crash) leaves no empty message behind. Until the first content arrives the
  `assistant.threads.setStatus` shimmer is the only thing the user sees, which
  is exactly what it is for.

  ## Rate limiting

  `chat.appendStream` is Tier 4 (100+/min). Content is buffered and flushed on
  a #{700}ms cadence — under the limit, and fast enough to read as typing. The
  first chunk is flushed immediately so the message appears at once.

  ## Failure handling

  A session never outlives its turn: `finish/4` stops the stream, and an
  `@idle_timeout` watchdog closes a stream whose agent died mid-turn, so a
  message can't be left rendering as in-progress forever.
  """

  use GenServer, restart: :temporary

  require Logger

  alias Manfrod.Slack.API

  @flush_interval_ms 700
  @idle_timeout_ms :timer.minutes(3)

  # Slack caps task_update titles and details at 256 characters.
  @task_field_limit 256

  # ---------------------------------------------------------------------------
  # Public API
  # ---------------------------------------------------------------------------

  @doc """
  Ensure a session exists for `{channel, thread_ts}`.

  `recipient` is `nil` for DMs (where the app owns the conversation) and
  `%{user_id: ..., team_id: ...}` for channel threads, where Slack requires
  knowing whose in-progress view the stream belongs to.

  Returns `:ok`, or `{:error, reason}` if the session could not be started —
  callers must then fall back to posting a normal message.
  """
  @spec ensure_started(String.t(), String.t(), String.t(), map() | nil) :: :ok | {:error, term()}
  def ensure_started(bot_token, channel, thread_ts, recipient) do
    spec = {__MODULE__, {bot_token, channel, thread_ts, recipient}}

    case DynamicSupervisor.start_child(Manfrod.Slack.DynamicSupervisor, spec) do
      {:ok, _pid} -> :ok
      {:error, {:already_started, _pid}} -> :ok
      {:error, reason} -> {:error, reason}
    end
  end

  def start_link({_bot_token, channel, thread_ts, _recipient} = args) do
    GenServer.start_link(__MODULE__, args, name: via(channel, thread_ts))
  end

  @doc "Append generated text to the stream."
  @spec text(String.t(), String.t(), String.t()) :: :ok
  def text(channel, thread_ts, text) do
    cast(channel, thread_ts, {:text, text})
  end

  @doc """
  Name the progress card. Safe to call repeatedly — an unchanged title is not
  re-sent.
  """
  @spec plan(String.t(), String.t(), String.t()) :: :ok
  def plan(channel, thread_ts, title) do
    cast(channel, thread_ts, {:plan, title})
  end

  @doc """
  Name the progress card only if it has no name yet.

  The card has to open the moment the first tool runs, but the agent's own
  name for the job (`Manfrod.Agent.PlanTitle`) is still being generated at that
  point. Callers use this for the provisional name so that the real one, once
  it lands via `plan/3`, is never overwritten by a later tool call.
  """
  @spec plan_default(String.t(), String.t(), String.t()) :: :ok
  def plan_default(channel, thread_ts, title) do
    cast(channel, thread_ts, {:plan_default, title})
  end

  @doc """
  Add or update a step inside the progress card. `task` is
  `%{id:, title:, status:, details:, output:}` where status is `"pending"`,
  `"in_progress"`, `"complete"` or `"error"` — sending the same `id` again
  updates that step in place rather than adding a second one.
  """
  @spec task(String.t(), String.t(), map()) :: :ok
  def task(channel, thread_ts, task) do
    cast(channel, thread_ts, {:task, task})
  end

  @doc """
  Finalize the stream with the turn's complete text.

  `content` is the whole response, not the part that has not been sent yet —
  the session works out the difference itself, so a caller does not have to
  track what was streamed. `extra_chunks` are appended last (the feedback
  buttons).

  Returns `{:error, :not_streaming}` if no stream was ever opened, in which
  case the caller still owns delivering `content`.
  """
  @spec finish(String.t(), String.t(), String.t(), [map()]) :: :ok | {:error, term()}
  def finish(channel, thread_ts, content, extra_chunks \\ []) do
    GenServer.call(via(channel, thread_ts), {:finish, content, extra_chunks}, 30_000)
  catch
    :exit, reason -> {:error, {:no_session, reason}}
  end

  @doc "Close the stream without a final answer (interrupted, session died)."
  @spec abort(String.t(), String.t(), String.t() | nil) :: :ok
  def abort(channel, thread_ts, note \\ nil) do
    cast(channel, thread_ts, {:abort, note})
  end

  # ---------------------------------------------------------------------------
  # GenServer callbacks
  # ---------------------------------------------------------------------------

  @impl true
  def init({bot_token, channel, thread_ts, recipient}) do
    {:ok,
     %{
       bot_token: bot_token,
       channel: channel,
       thread_ts: thread_ts,
       recipient: recipient,
       ts: nil,
       pending: [],
       flush_timer: nil,
       idle_timer: schedule_idle(nil),
       turn_text: "",
       plan_title: nil,
       # Every step this turn, id => merged fields. Kept because a step is
       # announced and resolved by two separate events carrying different
       # fields, and each update re-sends the whole step.
       tasks: %{}
     }}
  end

  @impl true
  def handle_cast({:plan_default, _title}, %{plan_title: current} = state)
      when not is_nil(current) do
    {:noreply, state}
  end

  def handle_cast({:plan_default, title}, state) do
    handle_cast({:plan, title}, state)
  end

  def handle_cast({:plan, title}, %{plan_title: title} = state) do
    {:noreply, state}
  end

  def handle_cast({:plan, title}, state) do
    state =
      state
      |> Map.put(:plan_title, title)
      |> enqueue(%{type: "plan_update", title: truncate(title, @task_field_limit)})
      |> touch()

    {:noreply, maybe_flush(state)}
  end

  def handle_cast({:text, text}, state) do
    state =
      state
      |> Map.update!(:turn_text, &(&1 <> text))
      |> enqueue(%{type: "markdown_text", text: text})
      |> touch()

    {:noreply, maybe_flush(state)}
  end

  def handle_cast({:task, task}, state) do
    # A tool call ends the current stretch of narration: whatever text was
    # streamed before it belongs to that turn, not to the final answer, so the
    # reconciliation in finish/4 must not try to subtract it.
    merged = merge_task(state, task)

    state =
      state
      |> Map.put(:turn_text, "")
      |> put_in([:tasks, merged.id], merged)
      |> enqueue(task_chunk(merged))
      |> touch()

    {:noreply, maybe_flush(state)}
  end

  def handle_cast({:abort, note}, state) do
    close(state, abort_chunks(state, note))
    {:stop, :normal, state}
  end

  @impl true
  def handle_call({:finish, _content, _extra}, _from, %{ts: nil} = state) do
    # Nothing was ever streamed (start_stream failed, or the turn produced no
    # content at all) — the caller has to deliver the message the normal way.
    {:stop, :normal, {:error, :not_streaming}, state}
  end

  def handle_call({:finish, content, extra_chunks}, _from, state) do
    state = cancel_flush(state)

    tail = remaining_text(state.turn_text, content)
    tail_chunks = if tail == "", do: [], else: [%{type: "markdown_text", text: tail}]

    chunks =
      Enum.reverse(state.pending) ++
        close_open_tasks(state, "complete") ++ tail_chunks ++ extra_chunks

    result =
      case API.stop_stream(state.bot_token, state.channel, state.ts, chunks) do
        {:ok, _body} ->
          :ok

        {:error, reason} ->
          Logger.error(
            "Slack StreamSession failed to stop stream in #{state.channel}: #{inspect(reason)}"
          )

          {:error, reason}
      end

    {:stop, :normal, result, %{state | pending: []}}
  end

  @impl true
  def handle_info(:flush, state) do
    state = %{state | flush_timer: nil}

    if state.pending == [] do
      {:noreply, state}
    else
      {:noreply, maybe_flush(state)}
    end
  end

  def handle_info(:idle_timeout, state) do
    Logger.warning(
      "Slack StreamSession idle timeout in #{state.channel}/#{state.thread_ts}, closing stream"
    )

    close(state, abort_chunks(state, "_(przerwane - brak odpowiedzi)_"))
    {:stop, :normal, state}
  end

  # ---------------------------------------------------------------------------
  # Internals
  # ---------------------------------------------------------------------------

  defp via(channel, thread_ts) do
    {:via, Registry, {Manfrod.Slack.StreamRegistry, {channel, thread_ts}}}
  end

  defp cast(channel, thread_ts, message) do
    GenServer.cast(via(channel, thread_ts), message)
  catch
    # The session is gone (finished, timed out, crashed). Losing a chunk of a
    # stream that no longer exists is not worth taking the caller down for.
    :exit, _reason -> :ok
  end

  # `pending` is kept newest-first so consecutive text can be merged onto the
  # head in constant time; it is reversed on the way out.
  defp enqueue(state, %{type: "markdown_text", text: text} = chunk) do
    case state.pending do
      [%{type: "markdown_text", text: previous} | rest] ->
        %{state | pending: [%{type: "markdown_text", text: previous <> text} | rest]}

      pending ->
        %{state | pending: [chunk | pending]}
    end
  end

  defp enqueue(state, chunk) do
    %{state | pending: [chunk | state.pending]}
  end

  # Flush now if the cadence window is open, otherwise leave it to the timer.
  defp maybe_flush(%{flush_timer: nil} = state) do
    state = flush(state)
    %{state | flush_timer: Process.send_after(self(), :flush, @flush_interval_ms)}
  end

  defp maybe_flush(state), do: state

  defp cancel_flush(%{flush_timer: nil} = state), do: state

  defp cancel_flush(state) do
    Process.cancel_timer(state.flush_timer)
    %{state | flush_timer: nil}
  end

  defp flush(%{pending: []} = state), do: state

  defp flush(%{ts: nil} = state) do
    chunks = Enum.reverse(state.pending)

    opts =
      [chunks: chunks, task_display_mode: "plan"]
      |> put_recipient(state.recipient)

    case API.start_stream(state.bot_token, state.channel, state.thread_ts, opts) do
      {:ok, ts} ->
        clear_status(state)
        %{state | ts: ts, pending: []}

      {:error, reason} ->
        Logger.error(
          "Slack StreamSession failed to start stream in #{state.channel}: #{inspect(reason)}"
        )

        # Keep the content buffered: finish/4 sees ts == nil, tells the caller
        # it is not streaming, and the whole answer goes out as a normal message.
        state
    end
  end

  defp flush(state) do
    chunks = Enum.reverse(state.pending)

    case API.append_stream(state.bot_token, state.channel, state.ts, chunks) do
      {:ok, _body} ->
        %{state | pending: []}

      {:error, reason} ->
        Logger.warning(
          "Slack StreamSession failed to append to stream in #{state.channel}: #{inspect(reason)}"
        )

        # Dropped rather than retried: the complete text is sent again on
        # finish/4 anyway, and retrying would reorder chunks against the tasks.
        %{state | pending: []}
    end
  end

  # The shimmer and the stream say the same thing, so the shimmer's job ends
  # the moment there is real content on screen. Slack clears the status when
  # the app posts into the thread, but a stream is not an ordinary post and
  # the two would otherwise sit there together — so clear it explicitly.
  # Fire-and-forget: it must not delay the first chunk.
  defp clear_status(state) do
    %{bot_token: bot_token, channel: channel, thread_ts: thread_ts} = state
    Task.start(fn -> API.set_status(bot_token, channel, thread_ts, "") end)
    :ok
  end

  defp put_recipient(opts, nil), do: opts

  defp put_recipient(opts, %{user_id: user_id, team_id: team_id}) do
    opts
    |> Keyword.put(:recipient_user_id, user_id)
    |> Keyword.put(:recipient_team_id, team_id)
  end

  defp close(%{ts: nil}, _chunks), do: :ok

  defp close(state, chunks) do
    case API.stop_stream(state.bot_token, state.channel, state.ts, chunks) do
      {:ok, _body} ->
        :ok

      {:error, reason} ->
        Logger.warning(
          "Slack StreamSession failed to close stream in #{state.channel}: #{inspect(reason)}"
        )
    end
  end

  defp abort_chunks(state, note) do
    chunks = Enum.reverse(state.pending) ++ close_open_tasks(state, "error")
    if note, do: chunks ++ [%{type: "markdown_text", text: "\n\n" <> note}], else: chunks
  end

  # A step is announced with its arguments and resolved with its result, by two
  # separate events. Each update re-sends the whole step, so the fields the
  # resolving event doesn't carry are taken from what was already shown rather
  # than blanked out.
  defp merge_task(state, task) do
    previous = Map.get(state.tasks, task.id, %{})

    Map.merge(previous, Map.reject(task, fn {_key, value} -> is_nil(value) end))
  end

  # Slack keeps a step spinning until something resolves it, and the card spins
  # with it. A tool whose completion event never arrived (the agent crashed,
  # the turn was cut short) has to be resolved here, or the finished message is
  # left looking like it is still working.
  defp close_open_tasks(state, status) do
    state.tasks
    |> Map.values()
    |> Enum.filter(&(&1.status == "in_progress"))
    |> Enum.map(&task_chunk(%{&1 | status: status}))
  end

  @doc """
  What of `content` has not been streamed yet, given the text streamed since
  the last tool call.

  Normally the streamed text is exactly the final text and this is empty — the
  stream already showed the answer, and stopping it is all that is left. The
  divergent case (an error message replacing the answer, the blank-response
  fallback) appends instead of subtracting, because losing the final answer is
  worse than repeating a sentence.

  Public because it is the one piece of this module's behaviour worth pinning
  in a test without a Slack connection.
  """
  @spec remaining_text(String.t(), String.t()) :: String.t()
  def remaining_text(turn_text, content) do
    cond do
      String.trim(turn_text) == "" -> content
      String.trim(content) == String.trim(turn_text) -> ""
      String.starts_with?(content, turn_text) -> String.replace_prefix(content, turn_text, "")
      true -> "\n\n" <> content
    end
  end

  defp task_chunk(task) do
    %{
      type: "task_update",
      id: task.id,
      title: truncate(task.title, @task_field_limit),
      status: task.status
    }
    |> maybe_put(:details, truncate(task[:details], @task_field_limit))
    |> maybe_put(:output, truncate(task[:output], @task_field_limit))
  end

  defp maybe_put(map, _key, nil), do: map
  defp maybe_put(map, _key, ""), do: map
  defp maybe_put(map, key, value), do: Map.put(map, key, value)

  defp truncate(nil, _limit), do: nil

  defp truncate(text, limit) do
    if String.length(text) > limit do
      String.slice(text, 0, limit - 1) <> "…"
    else
      text
    end
  end

  defp touch(state) do
    %{state | idle_timer: schedule_idle(state.idle_timer)}
  end

  defp schedule_idle(previous) do
    if previous, do: Process.cancel_timer(previous)
    Process.send_after(self(), :idle_timeout, @idle_timeout_ms)
  end
end
