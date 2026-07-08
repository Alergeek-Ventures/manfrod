defmodule ManfrodWeb.UserAuth do
  @moduledoc """
  Plug-based authentication for the web interface.

  Provides plugs for:
  - `fetch_current_scope` — loads the current user from the session token
    and assigns `current_scope` to the conn/socket.
  - `require_authenticated_user` — halts with redirect to login if no user.
  - `require_admin` — halts with 403 if not the admin user.
  - `log_in_user/2` — creates a session token and stores it in the session.
  - `log_out_user/1` — deletes session tokens and clears the session.

  Also provides `on_mount` callbacks for LiveView `live_session`.
  """

  use ManfrodWeb, :verified_routes

  import Plug.Conn
  import Phoenix.Controller

  alias Manfrod.Accounts
  alias Manfrod.Accounts.Scope

  defp admin_emails, do: Application.get_env(:manfrod, :admin_emails, [])

  # ---------------------------------------------------------------------------
  # Plug callbacks
  # ---------------------------------------------------------------------------

  @doc """
  Fetches the current user from the session token and assigns `current_scope`.

  If no valid session token exists, `current_scope` is assigned as nil.
  """
  def fetch_current_scope(conn, _opts) do
    token = get_session(conn, :user_token)
    user = token && Accounts.get_user_by_session_token(token)

    scope = if user, do: Scope.for_user(user), else: nil

    assign(conn, :current_scope, scope)
  end

  @doc """
  Requires an authenticated user. Redirects to `/login` if not authenticated.
  """
  def require_authenticated_user(conn, _opts) do
    if conn.assigns[:current_scope] do
      conn
    else
      conn
      |> put_flash(:error, "You must sign in to access this page.")
      |> redirect(to: ~p"/login")
      |> halt()
    end
  end

  @doc """
  Requires one of the configured admin users.

  Must be called after `require_authenticated_user`.
  """
  def require_admin(conn, _opts) do
    scope = conn.assigns[:current_scope]

    if scope && scope.user.email in admin_emails() do
      conn
    else
      conn
      |> put_resp_content_type("text/plain")
      |> send_resp(403, "Forbidden")
      |> halt()
    end
  end

  @doc """
  Redirects to the app if the user is already authenticated.

  Used on the login page to skip it when already signed in.
  """
  def redirect_if_authenticated(conn, _opts) do
    if conn.assigns[:current_scope] do
      conn
      |> redirect(to: ~p"/")
      |> halt()
    else
      conn
    end
  end

  # ---------------------------------------------------------------------------
  # Session management
  # ---------------------------------------------------------------------------

  @doc """
  Logs the user in by creating a session token.
  """
  def log_in_user(conn, user) do
    token = Accounts.create_session_token(user)

    conn
    |> renew_session()
    |> put_session(:user_token, token)
    |> redirect(to: ~p"/")
  end

  @doc """
  Logs the user out by deleting all session tokens and clearing the session.
  """
  def log_out_user(conn) do
    scope = conn.assigns[:current_scope]

    if scope do
      Accounts.delete_user_session_tokens(scope.user)
    end

    conn
    |> renew_session()
    |> redirect(to: ~p"/login")
  end

  defp renew_session(conn) do
    delete_csrf_token()

    conn
    |> configure_session(renew: true)
    |> clear_session()
  end

  # ---------------------------------------------------------------------------
  # LiveView on_mount
  # ---------------------------------------------------------------------------

  @doc """
  `on_mount` hook for authenticated LiveView sessions.

  Assigns `current_scope` to the socket. If not authenticated,
  redirects to `/login`.
  """
  def on_mount(:require_authenticated, _params, session, socket) do
    socket = mount_current_scope(session, socket)

    if socket.assigns.current_scope do
      {:cont, socket}
    else
      socket =
        socket
        |> Phoenix.LiveView.put_flash(:error, "You must sign in to access this page.")
        |> Phoenix.LiveView.redirect(to: ~p"/login")

      {:halt, socket}
    end
  end

  def on_mount(:mount_current_scope, _params, session, socket) do
    {:cont, mount_current_scope(session, socket)}
  end

  defp mount_current_scope(session, socket) do
    Phoenix.Component.assign_new(socket, :current_scope, fn ->
      token = Map.get(session, "user_token")
      user = token && Accounts.get_user_by_session_token(token)
      if user, do: Scope.for_user(user), else: nil
    end)
  end
end
