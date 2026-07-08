defmodule Manfrod.Memory.ChannelMapping do
  use Ecto.Schema
  import Ecto.Changeset

  alias Manfrod.Accounts.User
  alias Manfrod.Memory.Project

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  @sources ~w(auto_detected admin_confirmed slack_command)
  @statuses ~w(active pending)

  schema "channel_mappings" do
    field :slack_channel_id, :string
    field :slack_channel_name, :string
    field :client_id, :string
    field :source, :string
    field :status, :string, default: "active"

    belongs_to :project, Project
    belongs_to :set_by_user, User, foreign_key: :set_by_user_id

    timestamps()
  end

  def changeset(mapping, attrs) do
    mapping
    |> cast(attrs, [
      :slack_channel_id,
      :slack_channel_name,
      :project_id,
      :client_id,
      :source,
      :status,
      :set_by_user_id
    ])
    |> validate_required([:slack_channel_id, :source, :status])
    |> validate_inclusion(:source, @sources)
    |> validate_inclusion(:status, @statuses)
    |> unique_constraint(:slack_channel_id)
  end

  def write_access(%__MODULE__{client_id: nil}), do: ["internal"]
  def write_access(%__MODULE__{client_id: cid}), do: ["internal", "external/#{cid}"]
end
