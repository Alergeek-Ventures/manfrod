defmodule Manfrod.Accounts.UserToken do
  @moduledoc """
  Session tokens for authenticated web users.

  Tokens are hashed before storage; only the hash is persisted.
  The raw token is sent to the client as a session cookie.
  """

  use Ecto.Schema

  import Ecto.Query

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  @rand_size 32
  @session_validity_in_days 60

  schema "user_tokens" do
    field :token, :binary
    field :context, :string

    belongs_to :user, Manfrod.Accounts.User

    timestamps(updated_at: false)
  end

  @doc """
  Generates a session token.

  Returns `{raw_token, user_token}` where `raw_token` is the value to
  store in the session cookie and `user_token` is the struct to insert.
  """
  def build_session_token(user) do
    raw_token = :crypto.strong_rand_bytes(@rand_size)
    hashed_token = hash_token(raw_token)

    {Base.url_encode64(raw_token, padding: false),
     %__MODULE__{
       token: hashed_token,
       context: "session",
       user_id: user.id
     }}
  end

  @doc """
  Returns the query for finding a user by session token.

  Tokens older than `@session_validity_in_days` are ignored.
  """
  def by_session_token_query(raw_token) do
    hashed_token =
      raw_token
      |> Base.url_decode64!(padding: false)
      |> hash_token()

    from t in __MODULE__,
      where: t.token == ^hashed_token and t.context == "session",
      where: t.inserted_at > ago(@session_validity_in_days, "day"),
      join: u in assoc(t, :user),
      select: u
  end

  defp hash_token(token) do
    :crypto.hash(:sha256, token)
  end
end
