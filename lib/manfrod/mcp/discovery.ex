defmodule Manfrod.Mcp.Discovery do
  @moduledoc """
  Best-effort auto-detection of a custom MCP server's name and logo, from
  nothing but its URL. Used when a user adds a custom connection — most
  MCP servers require OAuth before they'll answer `initialize`, so a
  missing name/logo here just means the user fills it in by hand.
  """

  @doc """
  Returns `%{name: String.t() | nil, logo_url: String.t() | nil}`.

  `name` comes from an unauthenticated MCP `initialize` call's
  `serverInfo.name`/`title` (works for servers that don't require auth to
  identify themselves). `logo_url` is a guess at the origin's favicon —
  stored as a URL, not downloaded, since we just need something to render
  in an `<img>` tag.
  """
  def fetch_info(mcp_url) do
    %{name: fetch_name(mcp_url), logo_url: fetch_logo(mcp_url)}
  end

  # Manfrod.Mcp.Client doesn't expose the raw initialize response (it only
  # returns the session id), so we do a minimal unauthenticated initialize
  # call here directly instead of round-tripping through it.
  defp fetch_name(mcp_url) do
    body = %{
      "jsonrpc" => "2.0",
      "id" => 1,
      "method" => "initialize",
      "params" => %{
        "protocolVersion" => "2025-06-18",
        "capabilities" => %{},
        "clientInfo" => %{"name" => "manfrod", "version" => "1.0"}
      }
    }

    case Req.post(mcp_url,
           headers: [{"accept", "application/json, text/event-stream"}],
           json: body,
           connect_options: [timeout: 5_000],
           receive_timeout: 8_000
         ) do
      {:ok, %Req.Response{status: 200, body: %{"result" => %{"serverInfo" => info}}}} ->
        info["title"] || info["name"]

      _ ->
        nil
    end
  rescue
    _ -> nil
  end

  defp fetch_logo(mcp_url) do
    origin = origin(mcp_url)

    ["/favicon.svg", "/favicon.ico"]
    |> Enum.find_value(fn path -> probe_image(origin <> path) end)
  end

  defp probe_image(url) do
    case Req.get(url, connect_options: [timeout: 5_000], receive_timeout: 8_000) do
      {:ok, %Req.Response{status: 200} = resp} ->
        content_type = Req.Response.get_header(resp, "content-type") |> List.first() || ""
        if String.starts_with?(content_type, "image/"), do: url, else: nil

      _ ->
        nil
    end
  rescue
    _ -> nil
  end

  defp origin(url) do
    uri = URI.parse(url)
    %{uri | path: nil, query: nil, fragment: nil} |> URI.to_string()
  end
end
