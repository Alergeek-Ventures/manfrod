defmodule Manfrod.Memory.Project do
  use Ecto.Schema
  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "projects" do
    field :slug, :string
    field :name, :string

    has_many :channel_mappings, Manfrod.Memory.ChannelMapping
    has_many :project_memberships, Manfrod.Memory.ProjectMembership

    timestamps()
  end

  def changeset(project, attrs) do
    project
    |> cast(attrs, [:slug, :name])
    |> validate_required([:slug, :name])
    |> unique_constraint(:slug)
  end
end
