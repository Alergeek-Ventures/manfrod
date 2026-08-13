defmodule Manfrod.Analytics.ToolRollup do
  @moduledoc """
  One day of call counts for a single tool — the "which tools get used"
  grain. Fleet-wide rather than per-person: a user who called `reserve_desk`
  three times still tells us the same thing about that tool as three
  different users each calling it once.
  """

  use Ecto.Schema

  import Ecto.Changeset

  @primary_key {:id, :binary_id, autogenerate: true}

  @fields [:date, :tool, :calls]

  schema "tool_daily_rollups" do
    field :date, :date
    field :tool, :string
    field :calls, :integer, default: 0

    timestamps()
  end

  @doc false
  def changeset(rollup, attrs) do
    rollup
    |> cast(attrs, @fields)
    |> validate_required([:date, :tool])
  end

  @doc """
  Fields replaced when re-running a rollup for a day that already has rows.
  """
  def upsert_fields, do: @fields -- [:date, :tool]
end
