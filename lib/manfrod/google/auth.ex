defmodule Manfrod.Google.Auth do
  @moduledoc """
  Google OAuth token management with lazy refresh.

  Checks whether a `GoogleIdentity`'s access token is still valid (with a 60s
  buffer) and refreshes it inline via Google's token endpoint when expired.
  The refreshed token is persisted back to the database.
  """

  require Logger

  alias Manfrod.Accounts.GoogleIdentity
  alias Manfrod.Repo

  @token_url "https://oauth2.googleapis.com/token"
  @expiry_buffer_seconds 60

  @doc """
  Returns a valid access token for the given `GoogleIdentity`.

  If the token is still valid, returns it immediately. If expired (or within
  #{@expiry_buffer_seconds}s of expiry), refreshes via Google's token endpoint
  and persists the new token.

  Returns `{:ok, access_token}` or `{:error, reason}`.
  """
  def ensure_valid_token(%GoogleIdentity{} = identity) do
    if token_valid?(identity) do
      {:ok, identity.access_token}
    else
      refresh_token(identity)
    end
  end

  defp token_valid?(%GoogleIdentity{access_token: nil}), do: false
  defp token_valid?(%GoogleIdentity{token_expires_at: nil}), do: false

  defp token_valid?(%GoogleIdentity{token_expires_at: expires_at}) do
    System.system_time(:second) + @expiry_buffer_seconds < expires_at
  end

  defp refresh_token(%GoogleIdentity{refresh_token: nil}) do
    {:error, :no_refresh_token}
  end

  defp refresh_token(%GoogleIdentity{} = identity) do
    client_id = Application.fetch_env!(:manfrod, :google_client_id)
    client_secret = Application.fetch_env!(:manfrod, :google_client_secret)

    case Req.post(@token_url,
           form: [
             grant_type: "refresh_token",
             refresh_token: identity.refresh_token,
             client_id: client_id,
             client_secret: client_secret
           ]
         ) do
      {:ok, %Req.Response{status: 200, body: body}} ->
        new_access_token = body["access_token"]
        expires_in = body["expires_in"]
        new_expires_at = System.system_time(:second) + expires_in

        identity
        |> GoogleIdentity.changeset(%{
          access_token: new_access_token,
          token_expires_at: new_expires_at
        })
        |> Repo.update!()

        Logger.debug("Refreshed Google token for identity #{identity.id}")
        {:ok, new_access_token}

      {:ok, %Req.Response{status: status, body: body}} ->
        Logger.error("Google token refresh failed: #{status} — #{inspect(body)}")
        {:error, {:refresh_failed, status, body}}

      {:error, reason} ->
        Logger.error("Google token refresh HTTP error: #{inspect(reason)}")
        {:error, {:http_error, reason}}
    end
  end
end
