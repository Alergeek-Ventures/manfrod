defmodule Manfrod.Analytics.ActivityRollup do
  @moduledoc """
  One day of interaction activity for a single user — the adoption grain.

  Kept separate from `Manfrod.Analytics.UsageRollup` because these counts are
  per-person-per-day, not per-model: a user who hit two models in one day still
  sent one set of messages.
  """

  use Ecto.Schema

  import Ecto.Changeset

  alias Manfrod.Accounts.User

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  @fields [
    :date,
    :user_id,
    :messages_received,
    :messages_sent,
    :tool_calls,
    :sessions,
    :memory_searches,
    :notes_created
  ]

  schema "activity_daily_rollups" do
    field :date, :date

    field :messages_received, :integer, default: 0
    field :messages_sent, :integer, default: 0
    field :tool_calls, :integer, default: 0
    field :sessions, :integer, default: 0
    field :memory_searches, :integer, default: 0
    field :notes_created, :integer, default: 0

    belongs_to :user, User

    timestamps()
  end

  @doc false
  def changeset(rollup, attrs) do
    rollup
    |> cast(attrs, @fields)
    |> validate_required([:date])
  end

  @doc """
  Fields replaced when re-running a rollup for a day that already has rows.
  """
  def upsert_fields do
    @fields -- [:date, :user_id]
  end
end
