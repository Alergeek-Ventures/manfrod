defmodule Manfrod.Workers.McpExpiryWorker do
  @moduledoc """
  Runs hourly via Oban cron. For every user-owned MCP connection
  (`Manfrod.Mcp`), tries to refresh the access token before it expires;
  if that fails (or there's no refresh token), marks the connection
  expired and DMs the user once, asking them to reconnect.

  This is a proactive backstop — connections also get marked expired
  reactively when a live agent tool call hits a 401
  (`Manfrod.Tools.Mcp`). This worker catches expiry for connections that
  simply haven't been used since the token went stale.
  """

  use Oban.Worker,
    queue: :default,
    max_attempts: 3

  require Logger

  alias Manfrod.Mcp
  alias Manfrod.Mcp.ToolCache

  @impl Oban.Worker
  def perform(%Oban.Job{}) do
    checked =
      for {connection, provider} <- Mcp.list_all_connections_with_provider() do
        check_connection(provider, connection)
      end

    Logger.info("McpExpiryWorker: checked #{length(checked)} connection(s)")
    :ok
  end

  defp check_connection(provider, connection) do
    case Mcp.ensure_valid_token(connection) do
      {:ok, _access_token} ->
        :ok

      {:error, reason} ->
        Logger.info(
          "McpExpiryWorker: #{provider.id}/#{connection.user_id} unhealthy (#{inspect(reason)}), marking expired"
        )

        ToolCache.invalidate(connection.user_id, provider.id)
        {:ok, updated} = Mcp.mark_expired(connection)

        if is_nil(updated.notified_expired_at) do
          Manfrod.Proactive.send(
            connection.user_id,
            "Your #{provider.name} connection expired — reconnect it in the admin panel " <>
              "(MCP tab) so I can keep using it."
          )

          Mcp.mark_notified(updated)
        end

        :ok
    end
  end
end
