defmodule Manfrod.Memory.Node do
  @moduledoc """
  A knowledge node in the slipbox.

  Nodes with `processed_at = nil` are in the slipbox awaiting retrospection.
  Nodes with `conversation_id` set have provenance back to their source conversation.
  `project_id` is stamped at creation from the source channel's mapping (see
  `Manfrod.Memory.Access.get_active_mapping/1`) and is nil for nodes from
  unmapped channels or created before this field existed.
  """
  use Ecto.Schema
  import Ecto.Changeset

  alias Manfrod.Accounts.User
  alias Manfrod.Memory.{Conversation, Project}

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "nodes" do
    field :content, :string
    field :embedding, Pgvector.Ecto.Vector
    field :processed_at, :utc_datetime
    field :access, {:array, :string}, default: ["internal"]

    belongs_to :user, User
    belongs_to :conversation, Conversation
    belongs_to :project, Project

    timestamps()
  end

  def changeset(node, attrs) do
    node
    |> cast(attrs, [:content, :embedding, :conversation_id, :project_id, :processed_at, :access])
    |> validate_required([:content, :access])
    |> validate_length(:access, min: 1)
  end
end
