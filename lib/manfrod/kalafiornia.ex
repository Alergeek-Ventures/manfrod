defmodule Manfrod.Kalafiornia do
  @moduledoc """
  Per-user connection to the Kalafiornia office-door app. Login is a
  two-step email + PIN flow (`Manfrod.Kalafiornia.Client`) done on the
  integrations page; the resulting session is stored here so the
  `open_office_door` agent tool (`Manfrod.Tools.Kalafiornia`) can use it
  later without the user being present.
  """

  import Ecto.Query

  alias Manfrod.Kalafiornia.Client
  alias Manfrod.Kalafiornia.Connection
  alias Manfrod.Repo

  def get_connection(user_id) do
    Repo.one(from(c in Connection, where: c.user_id == ^user_id))
  end

  @doc "Step 1 of login: kalafiornia emails a PIN to `email`."
  def request_pin(email), do: Client.request_pin(email)

  @doc """
  Step 2 of login: exchanges `pin` for a session and stores it for
  `user_id`/`email`, replacing any previous connection.
  """
  def login_with_pin(user_id, email, pin) do
    with {:ok, session} <- Client.login_with_pin(pin) do
      save_session(user_id, email, session)
    end
  end

  defp save_session(user_id, email, session) do
    case get_connection(user_id) do
      nil -> %Connection{}
      conn -> conn
    end
    |> Connection.changeset(%{
      user_id: user_id,
      email: email,
      session: session,
      status: "connected"
    })
    |> Repo.insert_or_update()
  end

  def disconnect(user_id) do
    case get_connection(user_id) do
      nil -> {:ok, nil}
      conn -> Repo.delete(conn)
    end
  end

  def mark_invalid(%Connection{} = conn) do
    conn |> Connection.changeset(%{status: "invalid"}) |> Repo.update()
  end

  @doc """
  Opens `door_id` using `user_id`'s stored session. `{:error, :not_connected}`
  if they never logged in, `{:error, :session_invalid}` if kalafiornia
  rejected the session (also marks the connection invalid so the tool can
  tell them to reconnect).
  """
  def open_door(user_id, door_id) do
    case get_connection(user_id) do
      nil ->
        {:error, :not_connected}

      %Connection{status: "invalid"} ->
        {:error, :session_invalid}

      %Connection{session: session} = conn ->
        case Client.open_door(session, door_id) do
          {:ok, body} ->
            {:ok, body}

          {:error, :not_logged_in} ->
            mark_invalid(conn)
            {:error, :session_invalid}

          {:error, reason} ->
            {:error, reason}
        end
    end
  end
end
