defmodule Manfrod.Memory.Message do
  @moduledoc """
  An individual message in a conversation.

  Messages with `conversation_id = nil` are pending/active messages
  that haven't been assigned to a closed conversation yet.
  """
  use Ecto.Schema
  import Ecto.Changeset

  alias Manfrod.Accounts.User
  alias Manfrod.Memory.Conversation

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "messages" do
    field :role, :string
    field :content, :string
    field :received_at, :utc_datetime

    belongs_to :user, User
    belongs_to :conversation, Conversation

    timestamps()
  end

  @doc """
  Changeset for creating a new pending message.
  """
  def changeset(message, attrs) do
    message
    |> cast(attrs, [:role, :content, :received_at, :conversation_id])
    |> validate_required([:role, :content, :received_at])
    |> validate_inclusion(:role, ["user", "assistant"])
  end
end
