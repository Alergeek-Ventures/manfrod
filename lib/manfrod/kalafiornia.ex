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

  @doc """
  The office door's access log: `%{time: DateTime, event, door_id, user_name,
  opened_by}` entries, oldest first. `opts`:

    * `:since` — a `Date`/`DateTime`, drop entries strictly before it
    * `:user_name` — case-insensitive substring match on `user_name`

  Returns `{:ok, entries}` or `{:error, reason}`. Meant to later back a
  "did this person badge in without starting Firmowid" check — for now it's
  just the raw filtered log.
  """
  def list_office_access_log(opts \\ []) do
    with {:ok, raw} <- Client.office_access_log() do
      entries =
        raw
        |> Enum.map(&normalize_access_entry/1)
        |> filter_since(Keyword.get(opts, :since))
        |> filter_user_name(Keyword.get(opts, :user_name))

      {:ok, entries}
    end
  end

  defp normalize_access_entry(%{
         "time" => time,
         "event" => event,
         "doorId" => door_id,
         "userName" => user_name,
         "openedBy" => opened_by
       }) do
    {:ok, dt, _offset} = DateTime.from_iso8601(time)
    %{time: dt, event: event, door_id: door_id, user_name: user_name, opened_by: opened_by}
  end

  defp filter_since(entries, nil), do: entries

  defp filter_since(entries, %Date{} = since) do
    filter_since(entries, DateTime.new!(since, ~T[00:00:00], "Etc/UTC"))
  end

  defp filter_since(entries, %DateTime{} = since) do
    Enum.filter(entries, &(DateTime.compare(&1.time, since) != :lt))
  end

  defp filter_user_name(entries, nil), do: entries

  defp filter_user_name(entries, wanted) do
    wanted = String.downcase(wanted)
    Enum.filter(entries, &String.contains?(String.downcase(&1.user_name), wanted))
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
