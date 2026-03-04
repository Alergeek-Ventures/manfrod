# Based on slack_elixir v1.2.1 (MIT) — https://github.com/ryanwinchester/slack_elixir

defmodule Manfrod.Slack.Supervisor do
  @moduledoc """
  Supervises the Slack integration processes.

  Starts the following children in order:

  1. Registries and dynamic supervisors (infrastructure)
  2. `ActivityHandler` (subscribes to PubSub for outbound delivery)
  3. `Socket` (WebSocket connection for inbound events)

  Bot identity is fetched via `auth.test` during init. If the Slack API is
  unreachable the supervisor will fail to start and the application supervisor
  will retry according to its strategy.
  """

  use Supervisor

  require Logger

  alias Manfrod.Slack.{API, Bot, ActivityHandler, EventHandler, Socket}

  @doc """
  Start the Slack supervisor.

  Expects a keyword list with:

  - `:app_token` — Slack app-level token (`xapp-…`) for Socket Mode
  - `:bot_token` — Slack bot OAuth token (`xoxb-…`) for Web API calls
  """
  @spec start_link(keyword()) :: Supervisor.on_start()
  def start_link(config) do
    Supervisor.start_link(__MODULE__, config, name: __MODULE__)
  end

  @impl true
  def init(config) do
    app_token = Keyword.fetch!(config, :app_token)
    bot_token = Keyword.fetch!(config, :bot_token)

    bot = fetch_identity!(bot_token)

    children = [
      # Infrastructure
      {Registry, keys: :unique, name: Manfrod.Slack.MessageServerRegistry},
      {DynamicSupervisor, strategy: :one_for_one, name: Manfrod.Slack.DynamicSupervisor},
      {PartitionSupervisor, child_spec: Task.Supervisor, name: Manfrod.Slack.TaskSupervisors},
      # Outbound: PubSub → Slack delivery
      {ActivityHandler, bot_token},
      # Inbound: Slack → Agent
      {Socket, {app_token, bot, EventHandler}}
    ]

    Supervisor.init(children, strategy: :one_for_one)
  end

  defp fetch_identity!(bot_token) do
    case API.get("auth.test", bot_token) do
      {:ok, %{"bot_id" => _} = body} ->
        bot = Bot.from_auth_test(bot_token, body)
        Logger.info("Slack bot identity: #{bot.user_id} (team #{bot.team_id})")
        bot

      {:error, reason} ->
        raise "Failed to fetch Slack bot identity: #{inspect(reason)}"
    end
  end
end
