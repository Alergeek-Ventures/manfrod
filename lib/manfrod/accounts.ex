defmodule Manfrod.Accounts do
  @moduledoc """
  User identity for multitenancy.

  Users are auto-provisioned from Slack on first DM — no passwords, no signup.
  Google Sign-In links a `GoogleIdentity` to an existing Slack user (matched
  by email). Google-only users are rejected — you must DM the bot first.

  Each user anchors their own memory graph, conversations, and reminders.
  """

  import Ecto.Query

  alias Manfrod.Repo
  alias Manfrod.Accounts.GoogleIdentity
  alias Manfrod.Accounts.User
  alias Manfrod.Accounts.UserToken

  # ---------------------------------------------------------------------------
  # Slack-based provisioning
  # ---------------------------------------------------------------------------

  @doc """
  Find a user by Slack ID, or create one if they don't exist.

  The `slack_dm_channel_id` is required for user creation (first interaction
  must be a DM). For existing users the DM channel is already stored.

  Returns `{:ok, %User{}}`. The name and email are updated if provided.
  """
  def find_or_create_by_slack_id(slack_id, slack_dm_channel_id, name \\ nil, email \\ nil) do
    case Repo.one(from(u in User, where: u.slack_id == ^slack_id)) do
      nil ->
        attrs = %{
          slack_id: slack_id,
          slack_dm_channel_id: slack_dm_channel_id,
          name: name
        }

        attrs = if email, do: Map.put(attrs, :email, email), else: attrs

        %User{}
        |> User.changeset(attrs)
        |> Repo.insert()

      %User{} = user ->
        changes = %{}
        changes = if name && name != user.name, do: Map.put(changes, :name, name), else: changes

        changes =
          if email && is_nil(user.email), do: Map.put(changes, :email, email), else: changes

        if map_size(changes) > 0 do
          user
          |> User.changeset(changes)
          |> Repo.update()
        else
          {:ok, user}
        end
    end
  end

  @doc """
  Find a user by Slack ID. Returns nil if not found.

  Used for channel @mentions where user must already exist (first
  interaction must be a DM).
  """
  def get_user_by_slack_id(slack_id) do
    Repo.one(from(u in User, where: u.slack_id == ^slack_id))
  end

  # ---------------------------------------------------------------------------
  # Google Sign-In linking
  # ---------------------------------------------------------------------------

  @doc """
  Link a Google identity to an existing Slack user, or update an existing link.

  Flow:
  1. Look up existing `GoogleIdentity` by `google_sub` — if found, update
     tokens and return the associated user.
  2. Otherwise, look up `User` by `email` — if found, create a new
     `GoogleIdentity` linked to that user.
  3. If no user with that email exists, return `{:error, :no_slack_user}`.

  The `attrs` map must include:
  - `email` — Google-verified email address
  - `google_sub` — stable Google user ID
  - `name` — display name (optional, updates user if provided)
  - `access_token` — OAuth access token (optional)
  - `refresh_token` — OAuth refresh token (optional)
  - `token_expires_at` — token expiry as unix timestamp (optional)
  """
  def link_google_identity(attrs) do
    google_sub = Map.fetch!(attrs, :google_sub)
    email = Map.fetch!(attrs, :email)

    case get_google_identity_by_sub(google_sub) do
      %GoogleIdentity{} = identity ->
        # Existing link — update tokens
        identity = Repo.preload(identity, :user)

        identity
        |> GoogleIdentity.changeset(
          Map.take(attrs, [:access_token, :refresh_token, :token_expires_at])
        )
        |> Repo.update!()

        # Update user name if provided
        if attrs[:name] && attrs[:name] != identity.user.name do
          identity.user
          |> User.changeset(%{name: attrs[:name]})
          |> Repo.update!()
        end

        {:ok, identity.user}

      nil ->
        # No existing link — find user by email
        case get_user_by_email(email) do
          %User{} = user ->
            # Create Google identity for this user
            %GoogleIdentity{user_id: user.id}
            |> GoogleIdentity.changeset(
              Map.take(attrs, [:google_sub, :access_token, :refresh_token, :token_expires_at])
            )
            |> Repo.insert!()

            # Update user name/email if needed
            user_changes = %{}

            user_changes =
              if attrs[:name] && attrs[:name] != user.name,
                do: Map.put(user_changes, :name, attrs[:name]),
                else: user_changes

            user_changes =
              if is_nil(user.email),
                do: Map.put(user_changes, :email, email),
                else: user_changes

            user =
              if map_size(user_changes) > 0 do
                user
                |> User.changeset(user_changes)
                |> Repo.update!()
              else
                user
              end

            {:ok, user}

          nil ->
            {:error, :no_slack_user}
        end
    end
  end

  @doc """
  Get the GoogleIdentity for a user. Returns nil if not linked.
  """
  def get_google_identity(user_id) do
    Repo.one(from(g in GoogleIdentity, where: g.user_id == ^user_id))
  end

  @doc """
  Find a GoogleIdentity by Google sub. Returns nil if not found.
  """
  def get_google_identity_by_sub(google_sub) do
    Repo.one(from(g in GoogleIdentity, where: g.google_sub == ^google_sub))
  end

  @doc """
  Find a user by email. Returns nil if not found.
  """
  def get_user_by_email(email) when is_binary(email) do
    Repo.one(from(u in User, where: u.email == ^email))
  end

  def get_user_by_email(nil), do: nil

  # ---------------------------------------------------------------------------
  # General lookups
  # ---------------------------------------------------------------------------

  @doc """
  Get a user by ID. Raises if not found.
  """
  def get_user!(id) do
    Repo.get!(User, id)
  end

  @doc """
  Get a user by ID. Returns nil if not found.
  """
  def get_user(id) do
    Repo.get(User, id)
  end

  @doc """
  List all users.
  """
  def list_users do
    Repo.all(from(u in User, order_by: [asc: u.inserted_at]))
  end

  # ---------------------------------------------------------------------------
  # Session tokens
  # ---------------------------------------------------------------------------

  @doc """
  Generate a session token for the user and insert it into the database.

  Returns the raw token string to be stored in the session cookie.
  """
  def create_session_token(user) do
    {raw_token, user_token} = UserToken.build_session_token(user)
    Repo.insert!(user_token)
    raw_token
  end

  @doc """
  Get the user associated with the given session token.

  Returns nil if the token is invalid or expired.
  """
  def get_user_by_session_token(token) when is_binary(token) do
    Repo.one(UserToken.by_session_token_query(token))
  end

  def get_user_by_session_token(_), do: nil

  @doc """
  Delete all session tokens for the given user.

  Used on logout to invalidate all sessions.
  """
  def delete_user_session_tokens(user) do
    Repo.delete_all(from(t in UserToken, where: t.user_id == ^user.id and t.context == "session"))
  end

  # ---------------------------------------------------------------------------
  # Utilities
  # ---------------------------------------------------------------------------

  @doc """
  Backfill display names from Slack for users without names.

  Takes a Slack bot token. Iterates users where `name` is nil,
  fetches their real name from Slack, and updates the user record.

  Intended for one-time use from IEx:

      Manfrod.Accounts.backfill_names_from_slack(System.get_env("SLACK_BOT_TOKEN"))
  """
  def backfill_names_from_slack(token) when is_binary(token) do
    users_without_names =
      User
      |> where([u], is_nil(u.name))
      |> Repo.all()

    Enum.each(users_without_names, fn user ->
      case Manfrod.Slack.API.fetch_user_name(token, user.slack_id) do
        {:ok, name} ->
          user
          |> User.changeset(%{name: name})
          |> Repo.update()

        :error ->
          :skip
      end
    end)
  end

  @doc """
  List all user IDs that have unprocessed slipbox nodes.
  Used by RetrospectionWorker to iterate per-user.
  """
  def user_ids_with_slipbox_nodes do
    from(n in Manfrod.Memory.Node,
      where: is_nil(n.processed_at),
      distinct: n.user_id,
      select: n.user_id
    )
    |> Repo.all()
  end
end
