# Based on slack_elixir v1.2.1 (MIT) — https://github.com/ryanwinchester/slack_elixir

defmodule Manfrod.Slack.Socket do
  @moduledoc """
  WebSocket client for Slack Socket Mode.

  Connects to Slack's WebSocket gateway and dispatches incoming events, slash
  commands, and interactive payloads to the configured `event_handler` module.

  ## Differences from slack_elixir

  - `event_handler` is a separate module (decoupled from bot identity)
  - `interactive` payloads are dispatched (slack_elixir dropped them silently)
  - Reconnection with exponential backoff + jitter on disconnect
  - `disconnect` frames are handled gracefully
  - Self-message filter uses `bot.id` correctly (slack_elixir matched on a
    non-existent struct field)
  """

  use WebSockex

  require Logger

  alias Manfrod.Slack.API

  @max_reconnect_attempts 10

  # ---------------------------------------------------------------------------
  # Public API
  # ---------------------------------------------------------------------------

  @doc """
  Start the Socket Mode WebSocket connection.

  Expects a tuple of `{app_token, bot, event_handler}` where:

  - `app_token` — Slack app-level token (`xapp-…`)
  - `bot` — a `Manfrod.Slack.Bot` struct
  - `event_handler` — module implementing `handle_event/3`
  """
  @spec start_link({String.t(), Manfrod.Slack.Bot.t(), module()}) ::
          {:ok, pid()} | {:error, term()}
  def start_link({app_token, bot, event_handler}) do
    state = %{
      app_token: app_token,
      bot: bot,
      event_handler: event_handler,
      reconnect_attempts: 0
    }

    case API.post("apps.connections.open", app_token, %{}) do
      {:ok, %{"url" => url}} ->
        WebSockex.start_link(url, __MODULE__, state, name: __MODULE__)

      {:error, reason} ->
        {:error, {:connection_open_failed, reason}}
    end
  end

  # ---------------------------------------------------------------------------
  # WebSockex callbacks
  # ---------------------------------------------------------------------------

  @impl WebSockex
  def handle_frame({:text, raw}, state) do
    case Jason.decode(raw) do
      {:ok, message} ->
        handle_message(message, state)

      {:error, reason} ->
        Logger.debug("Slack Socket received non-JSON frame: #{inspect(reason)}")
        {:ok, state}
    end
  end

  def handle_frame(_frame, state), do: {:ok, state}

  @impl WebSockex
  def handle_disconnect(_connection_status, state) do
    attempts = state.reconnect_attempts

    if attempts >= @max_reconnect_attempts do
      Logger.error("Slack Socket gave up reconnecting after #{attempts} attempts")
      {:ok, state}
    else
      delay = min(30_000, 1000 * Integer.pow(2, attempts)) + :rand.uniform(1000)

      Logger.warning(
        "Slack Socket disconnected. Reconnecting in #{delay}ms (attempt #{attempts + 1})"
      )

      Process.sleep(delay)

      case API.post("apps.connections.open", state.app_token, %{}) do
        {:ok, %{"url" => url}} ->
          {:reconnect, url, %{state | reconnect_attempts: attempts + 1}}

        {:error, reason} ->
          Logger.error("Slack Socket failed to obtain new WSS URL: #{inspect(reason)}")
          # Recurse via the same callback by returning reconnect with incremented attempts
          handle_disconnect(nil, %{state | reconnect_attempts: attempts + 1})
      end
    end
  end

  # ---------------------------------------------------------------------------
  # Message handlers (private)
  # ---------------------------------------------------------------------------

  defp handle_message(%{"type" => "hello"}, state) do
    Logger.info("Slack Socket connected (hello received)")
    {:ok, %{state | reconnect_attempts: 0}}
  end

  defp handle_message(
         %{
           "type" => "events_api",
           "payload" => %{"event" => event} = _payload
         } = envelope,
         state
       ) do
    dispatch_task(fn ->
      unless skip_event?(event, state.bot) do
        state.event_handler.handle_event(event["type"], event, state.bot)
      end
    end)

    {:reply, ack_frame(envelope), state}
  end

  defp handle_message(%{"type" => "slash_commands", "payload" => payload} = envelope, state) do
    dispatch_task(fn ->
      state.event_handler.handle_event("slash_commands", payload, state.bot)
    end)

    {:reply, ack_frame(envelope), state}
  end

  defp handle_message(%{"type" => "interactive", "payload" => payload} = envelope, state) do
    dispatch_task(fn ->
      state.event_handler.handle_event("interactive", payload, state.bot)
    end)

    {:reply, ack_frame(envelope), state}
  end

  defp handle_message(%{"type" => "disconnect", "reason" => reason}, state) do
    Logger.warning("Slack Socket received disconnect: #{reason}")
    {:ok, state}
  end

  defp handle_message(message, state) do
    Logger.debug("Slack Socket unhandled message: #{inspect(message)}")
    {:ok, state}
  end

  # ---------------------------------------------------------------------------
  # Helpers
  # ---------------------------------------------------------------------------

  defp dispatch_task(fun) do
    Task.Supervisor.start_child(
      {:via, PartitionSupervisor, {Manfrod.Slack.TaskSupervisors, self()}},
      fun
    )
  end

  defp skip_event?(%{"type" => "message", "user" => user_id}, %{user_id: bot_user_id})
       when user_id == bot_user_id,
       do: true

  defp skip_event?(%{"bot_id" => bot_id}, %{id: own_bot_id})
       when bot_id == own_bot_id,
       do: true

  defp skip_event?(_event, _bot), do: false

  defp ack_frame(%{"envelope_id" => envelope_id}) do
    {:text, Jason.encode!(%{"envelope_id" => envelope_id})}
  end
end
