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

  Returns `{:ok, %User{}}`. The name is updated if provided and different.
  """
  def find_or_create_by_slack_id(slack_id, name \\ nil) do
    case Repo.one(from(u in User, where: u.slack_id == ^slack_id)) do
      nil ->
        %User{}
        |> User.changeset(%{slack_id: slack_id, name: name})
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
  List all user IDs that have unprocessed slipbox nodes.
  Used by RetrospectionWorker to iterate per-user.
  """
  def user_ids_with_slipbox_nodes do
    from(n in "nodes",
      where: is_nil(n.processed_at),
      distinct: n.user_id,
      select: n.user_id
    )
    |> Repo.all()
  end
end
