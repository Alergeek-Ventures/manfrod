defmodule Manfrod.Memory.Node do
  @moduledoc """
  A knowledge node in the slipbox.

  Nodes with `processed_at = nil` are in the slipbox awaiting retrospection.
  Nodes with `conversation_id` set have provenance back to their source conversation.
  """
  use Ecto.Schema
  import Ecto.Changeset

  alias Manfrod.Accounts.User
  alias Manfrod.Memory.Conversation

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "nodes" do
    field :content, :string
    field :embedding, Pgvector.Ecto.Vector
    field :processed_at, :utc_datetime

    belongs_to :user, User
    belongs_to :conversation, Conversation

    timestamps()
  end

  def changeset(node, attrs) do
    node
    |> cast(attrs, [:content, :embedding, :conversation_id, :processed_at])
    |> validate_required([:content])
  end
end
