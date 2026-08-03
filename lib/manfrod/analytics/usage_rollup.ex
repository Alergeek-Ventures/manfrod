defmodule Manfrod.Analytics.UsageRollup do
  @moduledoc """
  One day of LLM usage for a single (user, model, purpose) combination.

  Aggregated from `audit_events` by `Manfrod.Analytics.Rollup` before the raw
  events age out of their 7-day retention. `user_id` is nil for system work
  that isn't attributable to a person (passive classifier, cron skills).
  """

  use Ecto.Schema

  import Ecto.Changeset

  alias Manfrod.Accounts.User

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  @fields [
    :date,
    :user_id,
    :model,
    :purpose,
    :provider,
    :tier,
    :calls,
    :failed_calls,
    :retries,
    :fallbacks,
    :input_tokens,
    :output_tokens,
    :cached_tokens,
    :cache_creation_tokens,
    :cost_usd,
    :uncached_cost_usd,
    :total_latency_ms
  ]

  schema "usage_daily_rollups" do
    field :date, :date
    field :model, :string
    field :purpose, :string
    field :provider, :string
    field :tier, :string

    field :calls, :integer, default: 0
    field :failed_calls, :integer, default: 0
    field :retries, :integer, default: 0
    field :fallbacks, :integer, default: 0

    field :input_tokens, :integer, default: 0
    field :output_tokens, :integer, default: 0
    field :cached_tokens, :integer, default: 0
    field :cache_creation_tokens, :integer, default: 0

    field :cost_usd, :decimal, default: Decimal.new(0)
    field :uncached_cost_usd, :decimal, default: Decimal.new(0)

    field :total_latency_ms, :integer, default: 0

    belongs_to :user, User

    timestamps()
  end

  @doc false
  def changeset(rollup, attrs) do
    rollup
    |> cast(attrs, @fields)
    |> validate_required([:date, :model, :purpose])
  end

  @doc """
  Fields replaced when re-running a rollup for a day that already has rows.
  """
  def upsert_fields do
    @fields -- [:date, :user_id, :model, :purpose]
  end
end
