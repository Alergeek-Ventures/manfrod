defmodule ManfrodWeb.LogoutController do
  use ManfrodWeb, :controller

  def delete(conn, _params) do
    ManfrodWeb.UserAuth.log_out_user(conn)
  end
end
