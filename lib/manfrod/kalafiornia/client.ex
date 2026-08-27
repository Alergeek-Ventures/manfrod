defmodule Manfrod.Kalafiornia.Client do
  @moduledoc """
  Thin HTTP client for kalafiornia.pl, the office-door app.

  There's no API/OAuth here — it's the same three requests a human does in
  a browser: email a PIN, exchange the PIN for a plain `session` cookie,
  then POST the door id with that cookie attached.
  """

  require Logger

  @base_url "https://kalafiornia.pl"

  @doc "Kicks off login: kalafiornia emails a PIN to `email`."
  def request_pin(email) do
    case Req.post(@base_url <> "/login/",
           form: %{email: email},
           redirect: false,
           receive_timeout: 10_000
         ) do
      {:ok, %Req.Response{status: status}} when status in 200..399 -> :ok
      {:ok, %Req.Response{status: status}} -> {:error, {:unexpected_status, status}}
      {:error, reason} -> {:error, reason}
    end
  end

  @doc "Exchanges the emailed PIN for a session token. Returns `{:ok, session}`."
  def login_with_pin(pin) do
    case Req.post(@base_url <> "/login-by-pin",
           form: %{pin: pin},
           redirect: false,
           receive_timeout: 10_000
         ) do
      {:ok, %Req.Response{status: status} = resp} when status in 200..399 ->
        case session_cookie(resp) do
          nil -> {:error, :no_session_cookie}
          session -> {:ok, session}
        end

      {:ok, %Req.Response{status: status}} ->
        {:error, {:unexpected_status, status}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  @doc """
  Opens a door with a previously-obtained session. Returns `{:ok, body}`,
  `{:error, :not_logged_in}` if the session expired, or `{:error, reason}`.
  """
  def open_door(session, door_id) do
    case Req.post(@base_url <> "/open-door",
           headers: [
             {"accept", "application/json, text/plain, */*"},
             {"cookie", "session=#{session}"}
           ],
           json: %{doorId: door_id},
           receive_timeout: 10_000
         ) do
      {:ok, %Req.Response{status: 200, body: body}} ->
        if not_logged_in?(body), do: {:error, :not_logged_in}, else: {:ok, body}

      {:ok, %Req.Response{status: status, body: body}} ->
        Logger.warning("Kalafiornia.Client: open_door failed: HTTP #{status} #{inspect(body)}")
        {:error, {:unexpected_status, status}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  @doc """
  Fetches the office door's access log: every unlock event, newest last,
  as `%{"time" => iso8601, "event" => ..., "doorId" => ..., "userName" => ...,
  "openedBy" => "app" | "key"}`. Authenticated with a static API key (not a
  per-user session) — returns `{:ok, entries}` or `{:error, reason}`.
  """
  def office_access_log do
    api_key = Application.get_env(:manfrod, :kalafiornia_office_access_api_key)

    case Req.get(@base_url <> "/api/log/office-access",
           headers: [{"x-api-key", api_key}],
           receive_timeout: 10_000
         ) do
      {:ok, %Req.Response{status: 200, body: entries}} when is_list(entries) ->
        {:ok, entries}

      {:ok, %Req.Response{status: status, body: body}} ->
        Logger.warning(
          "Kalafiornia.Client: office_access_log failed: HTTP #{status} #{inspect(body)}"
        )

        {:error, {:unexpected_status, status}}

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp not_logged_in?(body) when is_binary(body), do: String.trim(body) == "Not logged in."
  defp not_logged_in?(_body), do: false

  defp session_cookie(%Req.Response{} = resp) do
    resp
    |> Req.Response.get_header("set-cookie")
    |> Enum.find_value(fn header ->
      case Regex.run(~r/^session=([^;]+)/, header) do
        [_, value] -> value
        nil -> nil
      end
    end)
  end
end
