defmodule ManfrodWeb.GoogleAuthController do
  @moduledoc """
  Handles Google OAuth Sign-In via Assent.

  Two actions:
  - `request/2` — builds the Google authorization URL and redirects.
  - `callback/2` — exchanges the code for tokens, validates the domain
    (`alergeek.ventures` only), and creates/links the user.

  Scopes requested:
  - `openid email profile` — identity
  - `https://www.googleapis.com/auth/calendar.events` — calendar (for future use)
  """

  use ManfrodWeb, :controller

  alias Manfrod.Accounts

  @allowed_domain "alergeek.ventures"

  @doc """
  Initiates Google OAuth by redirecting to Google's consent screen.
  """
  def request(conn, _params) do
    config = google_config(conn)

    case Assent.Strategy.Google.authorize_url(config) do
      {:ok, %{url: url, session_params: session_params}} ->
        conn
        |> put_session(:google_session_params, session_params)
        |> redirect(external: url)

      {:error, error} ->
        conn
        |> put_flash(:error, "Failed to start Google sign-in: #{inspect(error)}")
        |> redirect(to: ~p"/login")
    end
  end

  @doc """
  Handles the Google OAuth callback.

  Validates:
  1. `email_verified == true`
  2. `hd == "alergeek.ventures"` (hosted domain)

  On success, creates or links the user and starts a session.
  """
  def callback(conn, params) do
    session_params = get_session(conn, :google_session_params)

    config =
      conn
      |> google_config()
      |> Keyword.put(:session_params, session_params)

    conn = delete_session(conn, :google_session_params)

    case Assent.Strategy.Google.callback(config, params) do
      {:ok, %{user: google_user, token: token}} ->
        handle_google_user(conn, google_user, token)

      {:error, error} ->
        conn
        |> put_flash(:error, "Google authentication failed: #{inspect(error)}")
        |> redirect(to: ~p"/login")
    end
  end

  defp handle_google_user(conn, google_user, token) do
    email = google_user["email"]
    email_verified = google_user["email_verified"]
    hosted_domain = google_user["hd"]

    cond do
      email_verified != true ->
        conn
        |> put_flash(:error, "Email not verified by Google.")
        |> redirect(to: ~p"/login")

      hosted_domain != @allowed_domain ->
        conn
        |> put_flash(:error, "Only @#{@allowed_domain} accounts are allowed.")
        |> redirect(to: ~p"/login")

      true ->
        expires_at =
          if token["expires_in"] do
            System.system_time(:second) + token["expires_in"]
          end

        identity_attrs = %{
          email: String.downcase(email),
          name: google_user["name"],
          google_sub: google_user["sub"],
          access_token: token["access_token"],
          refresh_token: token["refresh_token"],
          token_expires_at: expires_at
        }

        case Accounts.link_google_identity(identity_attrs) do
          {:ok, user} ->
            ManfrodWeb.UserAuth.log_in_user(conn, user)

          {:error, :no_slack_user} ->
            conn
            |> put_flash(
              :error,
              "No account found for #{email}. Message the bot on Slack first."
            )
            |> redirect(to: ~p"/login")
        end
    end
  end

  defp google_config(conn) do
    [
      client_id: Application.fetch_env!(:manfrod, :google_client_id),
      client_secret: Application.fetch_env!(:manfrod, :google_client_secret),
      redirect_uri: url(conn, ~p"/auth/google/callback"),
      authorization_params: [
        access_type: "offline",
        prompt: "consent",
        hd: @allowed_domain,
        include_granted_scopes: true,
        scope: "openid email profile https://www.googleapis.com/auth/calendar.events"
      ]
    ]
  end
end
