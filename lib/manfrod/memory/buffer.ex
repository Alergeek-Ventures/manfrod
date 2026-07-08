defmodule Manfrod.Memory.Buffer do
  @moduledoc """
  Per-{channel, thread} GenServer that accumulates Slack messages for passive
  classification.

  Flushes to Classifier when:
  - 8+ messages accumulated, OR
  - 60s of silence (idle timer fires)

  One Buffer process per `{channel_id, thread_ts}` key (top-level channel
  messages use `nil` as thread_ts), started on demand via push/5. The process
  exits after an idle flush; the next message for that key starts a fresh one.
  """

  use GenServer, restart: :transient

  require Logger

  alias Manfrod.Memory.Classifier

  @flush_after_messages 8
  @flush_after_idle_ms 60_000

  # -- Public API --------------------------------------------------------------

  @doc """
  Push a message into the buffer for the given channel + thread.
  Starts the buffer process if it doesn't exist yet.
  """
  @spec push(String.t(), String.t() | nil, String.t() | nil, map(), String.t()) :: :ok
  def push(channel_id, thread_ts, channel_name, message, bot_token) do
    key = {channel_id, thread_ts}
    ensure_started(key, channel_name, bot_token)
    GenServer.cast(via(key), {:push, message})
  end

  # -- GenServer ---------------------------------------------------------------

  def start_link({key, channel_name, bot_token}) do
    GenServer.start_link(__MODULE__, {key, channel_name, bot_token}, name: via(key))
  end

  @impl true
  def init({{channel_id, thread_ts}, channel_name, bot_token}) do
    timer_ref = schedule_flush()

    {:ok,
     %{
       channel_id: channel_id,
       thread_ts: thread_ts,
       channel_name: channel_name,
       bot_token: bot_token,
       messages: [],
       timer_ref: timer_ref
     }}
  end

  @impl true
  def handle_cast({:push, message}, state) do
    messages = state.messages ++ [message]
    cancel_timer(state.timer_ref)

    if length(messages) >= @flush_after_messages do
      do_flush(messages, state)
      {:noreply, %{state | messages: [], timer_ref: schedule_flush()}}
    else
      {:noreply, %{state | messages: messages, timer_ref: schedule_flush()}}
    end
  end

  @impl true
  def handle_info(:flush, state) do
    if state.messages != [] do
      do_flush(state.messages, state)
    end

    # Idle: no new messages for the whole window — let the process die.
    # The next message for this {channel, thread} starts a fresh buffer.
    {:stop, :normal, %{state | messages: [], timer_ref: nil}}
  end

  # -- Private -----------------------------------------------------------------

  defp do_flush(messages, state) do
    Logger.info(
      "Buffer flushing #{length(messages)} messages from #{state.channel_id}/#{state.thread_ts || "root"}"
    )

    Task.start(fn ->
      Classifier.classify_batch(
        messages,
        state.channel_id,
        state.channel_name,
        state.bot_token
      )
    end)
  end

  defp schedule_flush do
    Process.send_after(self(), :flush, @flush_after_idle_ms)
  end

  defp cancel_timer(nil), do: :ok
  defp cancel_timer(ref), do: Process.cancel_timer(ref)

  defp via(key) do
    {:via, Registry, {Manfrod.Memory.BufferRegistry, key}}
  end

  defp ensure_started(key, channel_name, bot_token) do
    case Registry.lookup(Manfrod.Memory.BufferRegistry, key) do
      [{_pid, _}] ->
        :ok

      [] ->
        case DynamicSupervisor.start_child(
               Manfrod.Memory.BufferSupervisor,
               {__MODULE__, {key, channel_name, bot_token}}
             ) do
          {:ok, _} -> :ok
          {:error, {:already_started, _}} -> :ok
        end
    end
  end
end
