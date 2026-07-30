defmodule ManfrodWeb.McpOauthController do
  @moduledoc """
  OAuth 2.1 + PKCE connect/callback for user-owned MCP connections
  (Linear, Granola, ...). Mirrors the shape of `GoogleAuthController` but
  is generic over `provider` and uses Dynamic Client Registration instead
  of a static client_id/secret.
  """

  use ManfrodWeb, :controller

  alias Manfrod.Mcp
  alias Manfrod.Mcp.OAuth

  @doc "Starts the OAuth flow: builds the authorize URL and redirects."
  def connect(conn, %{"provider" => provider}) do
    user = conn.assigns.current_scope.user

    case Mcp.get_provider_for_user(user.id, provider) do
      %{mock: true} ->
        conn
        |> put_flash(:error, "#{provider} is not available yet.")
        |> redirect(to: ~p"/mcp")

      nil ->
        conn
        |> put_flash(:error, "Unknown provider.")
        |> redirect(to: ~p"/mcp")

      mcp_provider ->
        redirect_uri = url(conn, ~p"/mcp/#{provider}/callback")

        case OAuth.authorize_url(provider, mcp_provider.mcp_url, redirect_uri) do
          {:ok, %{url: url, code_verifier: code_verifier, state: state}} ->
            conn
            |> put_session(:mcp_oauth_provider, provider)
            |> put_session(:mcp_oauth_code_verifier, code_verifier)
            |> put_session(:mcp_oauth_state, state)
            |> redirect(external: url)

          {:error, reason} ->
            conn
            |> put_flash(:error, "Failed to start #{provider} connection: #{inspect(reason)}")
            |> redirect(to: ~p"/mcp")
        end
    end
  end

  @doc "Handles the OAuth callback: exchanges the code and stores the connection."
  def callback(conn, %{"provider" => provider} = params) do
    session_provider = get_session(conn, :mcp_oauth_provider)
    code_verifier = get_session(conn, :mcp_oauth_code_verifier)
    expected_state = get_session(conn, :mcp_oauth_state)

    conn =
      conn
      |> delete_session(:mcp_oauth_provider)
      |> delete_session(:mcp_oauth_code_verifier)
      |> delete_session(:mcp_oauth_state)

    cond do
      params["error"] ->
        conn
        |> put_flash(:error, "#{provider} authorization was denied.")
        |> redirect(to: ~p"/mcp")

      session_provider != provider or is_nil(code_verifier) or
          params["state"] != expected_state ->
        conn
        |> put_flash(:error, "Invalid OAuth session, please try connecting again.")
        |> redirect(to: ~p"/mcp")

      true ->
        redirect_uri = url(conn, ~p"/mcp/#{provider}/callback")
        user = conn.assigns.current_scope.user

        case OAuth.exchange_code(provider, params["code"], code_verifier, redirect_uri) do
          {:ok, tokens} ->
            expires_at =
              if tokens.expires_in do
                DateTime.utc_now()
                |> DateTime.add(tokens.expires_in, :second)
                |> DateTime.truncate(:second)
              end

            Mcp.save_tokens(user.id, provider, %{
              access_token: tokens.access_token,
              refresh_token: tokens.refresh_token,
              expires_at: expires_at,
              scope: tokens.scope,
              status: "connected",
              notified_expired_at: nil
            })

            conn
            |> put_flash(:info, "#{provider} connected.")
            |> redirect(to: ~p"/mcp")

          {:error, reason} ->
            conn
            |> put_flash(:error, "Failed to connect #{provider}: #{inspect(reason)}")
            |> redirect(to: ~p"/mcp")
        end
    end
  end

  @doc "Disconnects a provider for the current user."
  def disconnect(conn, %{"provider" => provider}) do
    user = conn.assigns.current_scope.user
    Mcp.disconnect(user.id, provider)

    conn
    |> put_flash(:info, "#{provider} disconnected.")
    |> redirect(to: ~p"/mcp")
  end
end
