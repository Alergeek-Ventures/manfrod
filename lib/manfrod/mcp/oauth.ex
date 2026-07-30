defmodule Manfrod.Mcp.OAuth do
  @moduledoc """
  Generic OAuth 2.1 + PKCE client for remote MCP servers, with RFC 7591
  Dynamic Client Registration so any MCP-spec-compliant provider (Linear,
  Granola, ...) can be connected without a pre-issued client_id/secret.

  Flow per provider, done once and cached in `mcp_oauth_clients`:
  1. Discover authorization server metadata (RFC 8414) from the MCP
     server's origin.
  2. Register this app as an OAuth client (RFC 7591) against the
     provider's `registration_endpoint`.

  Then per user, per connection attempt:
  3. Build a PKCE authorization URL (`authorize_url/2`).
  4. Exchange the returned code for tokens (`exchange_code/4`).
  5. Later, refresh when the access token expires (`refresh/2`).
  """

  require Logger

  alias Manfrod.Mcp

  @doc """
  Returns `{:ok, %{authorization_endpoint:, token_endpoint:, registration_endpoint:}}`
  discovered from the MCP server's origin, or `{:error, reason}`.
  """
  def discover_metadata(mcp_url) do
    origin = origin(mcp_url)

    with {:error, _} <- fetch_metadata(origin <> "/.well-known/oauth-authorization-server"),
         {:error, _} <- fetch_metadata(origin <> "/.well-known/openid-configuration") do
      {:error, :discovery_failed}
    end
  end

  defp fetch_metadata(url) do
    case Req.get(url, receive_timeout: 10_000) do
      {:ok, %Req.Response{status: 200, body: %{"authorization_endpoint" => _} = body}} ->
        {:ok,
         %{
           authorization_endpoint: body["authorization_endpoint"],
           token_endpoint: body["token_endpoint"],
           registration_endpoint: body["registration_endpoint"]
         }}

      {:ok, %Req.Response{status: status}} ->
        {:error, {:unexpected_status, status}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp origin(url) do
    uri = URI.parse(url)
    %{uri | path: nil, query: nil, fragment: nil} |> URI.to_string()
  end

  @doc """
  Ensures a registered OAuth client exists for `provider`, discovering
  metadata and performing Dynamic Client Registration if needed. Cached in
  `mcp_oauth_clients` after the first successful call.
  """
  def ensure_client(provider, mcp_url, redirect_uri) do
    case Mcp.get_oauth_client(provider) do
      nil -> register_client(provider, mcp_url, redirect_uri)
      client -> {:ok, client}
    end
  end

  defp register_client(provider, mcp_url, redirect_uri) do
    with {:ok, meta} <- discover_metadata(mcp_url),
         registration_endpoint when is_binary(registration_endpoint) <-
           meta.registration_endpoint || {:error, :no_dynamic_registration},
         {:ok, %Req.Response{status: status, body: body}}
         when status in [200, 201] <-
           Req.post(registration_endpoint,
             json: %{
               client_name: "Manfrod",
               redirect_uris: [redirect_uri],
               grant_types: ["authorization_code", "refresh_token"],
               response_types: ["code"],
               token_endpoint_auth_method: "none"
             },
             receive_timeout: 10_000
           ) do
      Mcp.save_oauth_client(provider, %{
        client_id: body["client_id"],
        client_secret: body["client_secret"],
        authorization_endpoint: meta.authorization_endpoint,
        token_endpoint: meta.token_endpoint,
        registration_endpoint: registration_endpoint
      })
    else
      {:error, reason} ->
        Logger.error("Mcp.OAuth: client registration failed for #{provider}: #{inspect(reason)}")
        {:error, reason}

      {:ok, %Req.Response{status: status, body: body}} ->
        Logger.error(
          "Mcp.OAuth: client registration rejected for #{provider}: HTTP #{status} #{inspect(body)}"
        )

        {:error, {:registration_rejected, status}}
    end
  end

  @doc """
  Builds a PKCE authorization URL for `provider` (id) at `mcp_url`.

  Returns `{:ok, %{url:, code_verifier:, state:}}` — the caller stashes
  `code_verifier` and `state` in the browser session for the callback.
  """
  def authorize_url(provider, mcp_url, redirect_uri) do
    with {:ok, client} <- ensure_client(provider, mcp_url, redirect_uri) do
      code_verifier = random_url_safe(64)
      code_challenge = code_challenge(code_verifier)
      state = random_url_safe(24)

      query =
        URI.encode_query(%{
          response_type: "code",
          client_id: client.client_id,
          redirect_uri: redirect_uri,
          code_challenge: code_challenge,
          code_challenge_method: "S256",
          state: state
        })

      {:ok, %{url: client.authorization_endpoint <> "?" <> query, code_verifier: code_verifier, state: state}}
    end
  end

  @doc "Exchanges an authorization code for tokens."
  def exchange_code(provider, code, code_verifier, redirect_uri) do
    with {:ok, client} <- fetch_client(provider) do
      post_token(client, %{
        grant_type: "authorization_code",
        code: code,
        redirect_uri: redirect_uri,
        client_id: client.client_id,
        code_verifier: code_verifier
      })
    end
  end

  @doc "Exchanges a refresh token for a fresh access token."
  def refresh(provider, refresh_token) do
    with {:ok, client} <- fetch_client(provider) do
      post_token(client, %{
        grant_type: "refresh_token",
        refresh_token: refresh_token,
        client_id: client.client_id
      })
    end
  end

  defp fetch_client(provider) do
    case Mcp.get_oauth_client(provider) do
      nil -> {:error, :client_not_registered}
      client -> {:ok, client}
    end
  end

  defp post_token(client, form) do
    form = if client.client_secret, do: Map.put(form, :client_secret, client.client_secret), else: form

    case Req.post(client.token_endpoint, form: form, receive_timeout: 10_000) do
      {:ok, %Req.Response{status: 200, body: body}} when is_map(body) ->
        {:ok,
         %{
           access_token: body["access_token"],
           refresh_token: body["refresh_token"],
           expires_in: body["expires_in"],
           scope: body["scope"]
         }}

      {:ok, %Req.Response{status: status, body: body}} ->
        Logger.error("Mcp.OAuth: token request failed: HTTP #{status} #{inspect(body)}")
        {:error, {:token_request_failed, status}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp random_url_safe(byte_size) do
    :crypto.strong_rand_bytes(byte_size) |> Base.url_encode64(padding: false)
  end

  defp code_challenge(verifier) do
    :crypto.hash(:sha256, verifier) |> Base.url_encode64(padding: false)
  end
end
