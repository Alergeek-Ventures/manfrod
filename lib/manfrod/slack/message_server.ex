# Based on slack_elixir v1.2.1 (MIT) — https://github.com/ryanwinchester/slack_elixir

defmodule Manfrod.Slack.MessageServer do
  @moduledoc """
  Per-channel rate-limited message queue for Slack.

  Slack enforces a rate limit of roughly 1 message per second per channel.
  Each `MessageServer` instance manages a FIFO queue for a single channel and
  drains it at `@message_rate_ms` intervals, ensuring we never exceed the limit.

  Servers are registered via `Manfrod.Slack.MessageServerRegistry` and
  supervised under `Manfrod.Slack.DynamicSupervisor`. Use `ensure_started/2`
  for idempotent on-demand startup.
  """

  use GenServer

  require Logger

  alias Manfrod.Slack.API

  @message_rate_ms :timer.seconds(1)

  # ---------------------------------------------------------------------------
  # Public API
  # ---------------------------------------------------------------------------

  @doc """
  Start a message server for the given channel, linked to the caller.
  """
  @spec start_link({String.t(), String.t()}) :: GenServer.on_start()
  def start_link({bot_token, channel}) do
    GenServer.start_link(__MODULE__, {bot_token, channel}, name: via_tuple(channel))
  end

  @doc """
  Start a message server under `Manfrod.Slack.DynamicSupervisor`.
  """
  @spec start_supervised(String.t(), String.t()) :: DynamicSupervisor.on_start_child()
  def start_supervised(bot_token, channel) do
    DynamicSupervisor.start_child(
      Manfrod.Slack.DynamicSupervisor,
      {__MODULE__, {bot_token, channel}}
    )
  end

  @doc """
  Ensure a message server is running for `channel`. Starts one via the
  DynamicSupervisor if it doesn't already exist. Returns `:ok`.
  """
  @spec ensure_started(String.t(), String.t()) :: :ok
  def ensure_started(bot_token, channel) do
    case start_supervised(bot_token, channel) do
      {:ok, _pid} -> :ok
      {:error, {:already_started, _pid}} -> :ok
    end
  end

  @doc """
  Enqueue a message to be sent to `channel`.

  `message` can be a plain string (sent as `%{"channel" => channel, "text" => text}`)
  or a map (merged with `%{"channel" => channel}`) for Block Kit payloads.
  """
  @spec send_message(String.t(), String.t() | map()) :: :ok
  def send_message(channel, message) do
    GenServer.cast(via_tuple(channel), {:send_message, message})
  end

  @doc """
  Stop the message server for `channel`.
  """
  @spec stop(String.t()) :: :ok
  def stop(channel) do
    GenServer.stop(via_tuple(channel))
  end

  # ---------------------------------------------------------------------------
  # GenServer callbacks
  # ---------------------------------------------------------------------------

  @impl GenServer
  def init({bot_token, channel}) do
    state = %{
      bot_token: bot_token,
      channel: channel,
      queue: :queue.new(),
      timer_ref: nil
    }

    {:ok, state}
  end

  @impl GenServer
  def handle_cast({:send_message, message}, state) do
    state = enqueue(state, message)

    state =
      if is_nil(state.timer_ref) do
        send_next(state)
      else
        state
      end

    {:noreply, state}
  end

  @impl GenServer
  def handle_info(:send, state) do
    state = %{state | timer_ref: nil}

    state =
      if :queue.is_empty(state.queue) do
        state
      else
        send_next(state)
      end

    {:noreply, state}
  end

  # ---------------------------------------------------------------------------
  # Internals
  # ---------------------------------------------------------------------------

  defp via_tuple(channel) do
    {:via, Registry, {Manfrod.Slack.MessageServerRegistry, channel}}
  end

  defp enqueue(state, message) do
    %{state | queue: :queue.in(message, state.queue)}
  end

  defp send_next(state) do
    case :queue.out(state.queue) do
      {{:value, message}, queue} ->
        do_send(state.bot_token, state.channel, message)
        timer_ref = Process.send_after(self(), :send, @message_rate_ms)
        %{state | queue: queue, timer_ref: timer_ref}

      {:empty, _queue} ->
        %{state | timer_ref: nil}
    end
  end

  defp do_send(bot_token, channel, message) when is_binary(message) do
    do_send(bot_token, channel, %{text: message})
  end

  defp do_send(bot_token, channel, message) when is_map(message) do
    body = Map.put(message, :channel, channel)

    case API.post("chat.postMessage", bot_token, body) do
      {:ok, _body} ->
        :ok

      {:error, reason} ->
        Logger.error("Slack MessageServer failed to send to #{channel}: #{inspect(reason)}")
    end
  end
end
