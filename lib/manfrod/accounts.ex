defmodule Manfrod.Accounts do
  @moduledoc """
  User identity for multitenancy.

  Users are auto-provisioned from Slack — no passwords, no signup.
  Each user anchors their own memory graph, conversations, and reminders.
  """

  import Ecto.Query

  alias Manfrod.Repo
  alias Manfrod.Accounts.User

  @doc """
  Find a user by Slack ID, or create one if they don't exist.

  The `slack_dm_channel_id` is required for user creation (first interaction
  must be a DM). For existing users the DM channel is already stored.

  Returns `{:ok, %User{}}`. The name is updated if provided and different.
  """
  def find_or_create_by_slack_id(slack_id, slack_dm_channel_id, name \\ nil) do
    case Repo.one(from(u in User, where: u.slack_id == ^slack_id)) do
      nil ->
        %User{}
        |> User.changeset(%{
          slack_id: slack_id,
          slack_dm_channel_id: slack_dm_channel_id,
          name: name
        })
        |> Repo.insert()

      %User{} = user ->
        if name && name != user.name do
          user
          |> User.changeset(%{name: name})
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
