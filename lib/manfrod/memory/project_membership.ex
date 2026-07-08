defmodule Manfrod.Memory.ProjectMembership do
  use Ecto.Schema
  import Ecto.Changeset

  alias Manfrod.Accounts.User
  alias Manfrod.Memory.Project

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "project_memberships" do
    field :source, :string, default: "auto_detected"

    belongs_to :user, User
    belongs_to :project, Project

    timestamps(updated_at: false)
  end

  def changeset(membership, attrs) do
    membership
    |> cast(attrs, [:user_id, :project_id, :source])
    |> validate_required([:user_id, :project_id])
    |> unique_constraint([:user_id, :project_id])
  end
end
