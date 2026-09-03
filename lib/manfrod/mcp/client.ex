defmodule Manfrod.Mcp.Client do
  @moduledoc """
  Minimal MCP (Model Context Protocol) client over the "Streamable HTTP"
  transport — enough to list and call tools on a remote MCP server on
  behalf of a connected user.

  Each call is a fresh JSON-RPC session: `initialize` -> `notifications/initialized`
  -> the actual request. Servers may reply with either a plain JSON body or
  a single-event SSE stream; both are handled.
  """

  require Logger

  @protocol_version "2025-06-18"

  @doc "Lists the tools exposed by an MCP server. Returns `{:ok, [tool]}`, `{:error, :unauthorized}`, or `{:error, reason}`."
  def list_tools(mcp_url, access_token) do
    with {:ok, session_id} <- initialize(mcp_url, access_token) do
      case rpc(mcp_url, access_token, session_id, "tools/list", %{}) do
        {:ok, %{"tools" => tools}} -> {:ok, tools}
        {:ok, _} -> {:ok, []}
        error -> error
      end
    end
  end

  @doc "Calls a tool on a remote MCP server. Returns `{:ok, result}`, `{:error, :unauthorized}`, or `{:error, reason}`."
  def call_tool(mcp_url, access_token, tool_name, arguments) do
    with {:ok, session_id} <- initialize(mcp_url, access_token) do
      rpc(mcp_url, access_token, session_id, "tools/call", %{
        "name" => tool_name,
        "arguments" => arguments
      })
    end
  end

  defp initialize(mcp_url, access_token) do
    body = %{
      "jsonrpc" => "2.0",
      "id" => 1,
      "method" => "initialize",
      "params" => %{
        "protocolVersion" => @protocol_version,
        "capabilities" => %{},
        "clientInfo" => %{"name" => "manfrod", "version" => "1.0"}
      }
    }

    case post(mcp_url, access_token, nil, body) do
      {:ok, %Req.Response{status: 200} = resp} ->
        session_id = Req.Response.get_header(resp, "mcp-session-id") |> List.first()

        # Fire-and-forget notification, per spec, before any other request.
        post(
          mcp_url,
          access_token,
          session_id,
          %{"jsonrpc" => "2.0", "method" => "notifications/initialized"}
        )

        {:ok, session_id}

      {:ok, %Req.Response{status: status}} when status in [401, 403] ->
        {:error, :unauthorized}

      {:ok, %Req.Response{status: status, body: resp_body}} ->
        Logger.warning(
          "Mcp.Client: initialize failed for #{mcp_url}: HTTP #{status} #{inspect(resp_body)}"
        )

        {:error, {:unexpected_status, status}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp rpc(mcp_url, access_token, session_id, method, params) do
    body = %{"jsonrpc" => "2.0", "id" => 2, "method" => method, "params" => params}

    case post(mcp_url, access_token, session_id, body) do
      {:ok, %Req.Response{status: 200} = resp} ->
        parse_result(resp)

      {:ok, %Req.Response{status: status}} when status in [401, 403] ->
        {:error, :unauthorized}

      {:ok, %Req.Response{status: status, body: resp_body}} ->
        Logger.warning(
          "Mcp.Client: #{method} failed for #{mcp_url}: HTTP #{status} #{inspect(resp_body)}"
        )

        {:error, {:unexpected_status, status}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp post(mcp_url, access_token, session_id, body) do
    headers =
      [{"accept", "application/json, text/event-stream"}]
      |> then(fn h -> if session_id, do: [{"mcp-session-id", session_id} | h], else: h end)

    Req.post(mcp_url,
      auth: {:bearer, access_token},
      headers: headers,
      json: body,
      connect_options: [timeout: 5_000],
      receive_timeout: 15_000
    )
  end

  # Streamable HTTP servers may answer with a plain JSON body or a single
  # SSE event carrying the same JSON-RPC response in its `data:` field.
  defp parse_result(%Req.Response{body: %{"result" => result}}), do: {:ok, result}
  defp parse_result(%Req.Response{body: %{"error" => error}}), do: {:error, {:rpc_error, error}}

  defp parse_result(%Req.Response{body: body}) when is_binary(body) do
    body
    |> String.split("\n")
    |> Enum.find_value(fn
      "data: " <> json -> json
      _ -> nil
    end)
    |> case do
      nil ->
        {:error, :unparseable_response}

      json ->
        case Jason.decode(json) do
          {:ok, %{"result" => result}} -> {:ok, result}
          {:ok, %{"error" => error}} -> {:error, {:rpc_error, error}}
          _ -> {:error, :unparseable_response}
        end
    end
  end

  defp parse_result(_), do: {:error, :unparseable_response}
end
