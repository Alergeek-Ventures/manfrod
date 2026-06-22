defmodule ManfrodWeb.DevImpersonationController do
  use ManfrodWeb, :controller

  alias Manfrod.Accounts

  @impersonation_email "franek@alergeek.ventures"
  @loopback_ips [
    {127, 0, 0, 1},
    {0, 0, 0, 0, 0, 0, 0, 1}
  ]
  @local_hosts ["localhost", "127.0.0.1", "::1", "[::1]"]

  def create(conn, _params) do
    if local_request?(conn) do
      log_in_impersonated_user(conn)
    else
      conn
      |> put_resp_content_type("text/plain")
      |> send_resp(:not_found, "Not found")
      |> halt()
    end
  end

  defp log_in_impersonated_user(conn) do
    case Accounts.get_user_by_email(@impersonation_email) do
      nil ->
        conn
        |> put_flash(:error, "No local user found for #{@impersonation_email}.")
        |> redirect(to: ~p"/login")

      user ->
        ManfrodWeb.UserAuth.log_in_user(conn, user)
    end
  end

  defp local_request?(conn) do
    conn.remote_ip in @loopback_ips and conn.host in @local_hosts
  end
end
