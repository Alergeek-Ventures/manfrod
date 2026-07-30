defmodule Manfrod.Tools.Mcp do
  @moduledoc """
  Exposes each user's connected remote MCP servers (Linear, Granola, ...) as
  agent tools, namespaced by provider (`linear__create_issue`, ...).

  Connections are per-user (`Manfrod.Mcp`) — a tool only appears for the
  user who actually connected that provider. If a provider is unreachable
  or a user hasn't connected it, it's silently skipped rather than failing
  the whole turn.
  """

  require Logger

  alias Manfrod.Mcp
  alias Manfrod.Mcp.Client
  alias Manfrod.Mcp.ToolCache

  def definitions(%{user_id: nil}), do: []

  def definitions(%{user_id: user_id}) do
    user_id
    |> Mcp.providers_for_user()
    |> Enum.reject(& &1.mock)
    |> Enum.flat_map(fn provider -> provider_tools(user_id, provider) end)
  end

  defp provider_tools(user_id, provider) do
    case Mcp.get_connection(user_id, provider.id) do
      nil ->
        []

      %{status: "disconnected"} ->
        []

      connection ->
        case Mcp.ensure_valid_token(connection) do
          {:ok, access_token} ->
            fetch_tools(user_id, provider, access_token)

          {:error, reason} ->
            Logger.debug(
              "Tools.Mcp: no valid token for #{provider.id}/#{user_id}: #{inspect(reason)}"
            )

            []
        end
    end
  end

  defp fetch_tools(user_id, provider, access_token) do
    fetch = fn -> Client.list_tools(provider.mcp_url, access_token) end

    case ToolCache.get_or_fetch(user_id, provider.id, fetch) do
      {:ok, remote_tools} ->
        Enum.map(remote_tools, &build_tool(user_id, provider, access_token, &1))

      {:error, :unauthorized} ->
        handle_unauthorized(user_id, provider)
        []

      {:error, reason} ->
        Logger.warning("Tools.Mcp: failed to list tools for #{provider.id}: #{inspect(reason)}")
        []
    end
  end

  defp build_tool(user_id, provider, access_token, remote_tool) do
    name = "#{provider.id}__#{remote_tool["name"]}"

    ReqLLM.Tool.new!(
      name: name,
      description:
        "[#{provider.name} MCP] " <> (remote_tool["description"] || remote_tool["name"]),
      parameter_schema: remote_tool["inputSchema"] || %{"type" => "object", "properties" => %{}},
      callback: fn args ->
        call_remote_tool(user_id, provider, access_token, remote_tool["name"], args)
      end
    )
  end

  defp call_remote_tool(user_id, provider, access_token, remote_name, args) do
    case Client.call_tool(provider.mcp_url, access_token, remote_name, args) do
      {:ok, result} ->
        {:ok, format_result(result)}

      {:error, :unauthorized} ->
        handle_unauthorized(user_id, provider)

        {:ok,
         "ERROR: #{provider.name} connection expired. The user needs to reconnect it at the web app."}

      {:error, reason} ->
        {:ok, "#{provider.name} MCP call failed: #{inspect(reason)}"}
    end
  end

  defp format_result(%{"content" => content}) when is_list(content) do
    content
    |> Enum.map(fn
      %{"type" => "text", "text" => text} -> text
      other -> inspect(other)
    end)
    |> Enum.join("\n")
  end

  defp format_result(result), do: inspect(result)

  # Mark the connection expired and DM the user once (not on every call) —
  # `Mcp.mark_expired/1` is itself idempotent, but we still gate the
  # notification separately since a connection can flip status without a
  # fresh 401 (e.g. after a failed proactive refresh in the cron worker).
  defp handle_unauthorized(user_id, provider) do
    ToolCache.invalidate(user_id, provider.id)

    case Mcp.get_connection(user_id, provider.id) do
      nil ->
        :ok

      connection ->
        was_connected = connection.status != "expired"
        {:ok, connection} = Mcp.mark_expired(connection)

        if was_connected or is_nil(connection.notified_expired_at) do
          notify_expired(user_id, provider)
          Mcp.mark_notified(connection)
        end
    end
  end

  defp notify_expired(user_id, provider) do
    Manfrod.Proactive.send(
      user_id,
      "Your #{provider.name} connection expired — reconnect it in the admin panel " <>
        "(MCP tab) so I can keep using it."
    )
  end
end
