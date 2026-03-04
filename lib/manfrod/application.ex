defmodule Manfrod.Application do
  @moduledoc false

  use Application

  @impl true
  def start(_type, _args) do
    children =
      [
        Manfrod.Repo,
        {Phoenix.PubSub, name: Manfrod.PubSub},
        {Oban, Application.fetch_env!(:manfrod, Oban)},
        # Event handlers (subscribe to global PubSub)
        Manfrod.Events.Persister,
        Manfrod.Memory.FlushHandler,
        # Per-user agent processes (DynamicSupervisor + Registry)
        Manfrod.Agent.Supervisor,
        ManfrodWeb.Endpoint
      ] ++ slack_children()

    opts = [strategy: :one_for_one, name: Manfrod.Supervisor]
    result = Supervisor.start_link(children, opts)

    # Add logger handler after PubSub is running
    add_log_handler()

    result
  end

  defp slack_children do
    app_token = Application.get_env(:manfrod, :slack_app_token)
    bot_token = Application.get_env(:manfrod, :slack_bot_token)

    if app_token && bot_token do
      [{Manfrod.Slack.Supervisor, app_token: app_token, bot_token: bot_token}]
    else
      []
    end
  end

  defp add_log_handler do
    handler_config = %{
      level: :all
    }

    :logger.add_handler(:manfrod_log_handler, Manfrod.Events.LogHandler, handler_config)
  end

  @impl true
  def config_change(changed, _new, removed) do
    ManfrodWeb.Endpoint.config_change(changed, removed)

    :ok
  end
end
