defmodule Manfrod.Events.AuditEvent do
  @moduledoc """
  Persisted audit event for agent activity.

  Stores a subset of Activity fields for historical viewing.
  The `reply_to` field is intentionally excluded as it contains
  ephemeral references (PIDs, chat_ids) that don't survive restarts.
  """
  use Ecto.Schema

  import Ecto.Changeset

  alias Manfrod.Accounts.User
  alias Manfrod.Events.Activity

  @primary_key {:id, :binary_id, autogenerate: true}
  @foreign_key_type :binary_id

  schema "audit_events" do
    field :type, :string
    field :source, :string
    field :meta, :map, default: %{}
    field :timestamp, :utc_datetime_usec

    belongs_to :user, User

    timestamps(updated_at: false)
  end

  @doc """
  Creates a changeset from an Activity struct.
  """
  def changeset_from_activity(%Activity{} = activity) do
    attrs = %{
      type: to_string(activity.type),
      source: if(activity.source, do: to_string(activity.source)),
      meta: stringify_meta(activity.meta),
      timestamp: activity.timestamp,
      user_id: activity.user_id
    }

    %__MODULE__{}
    |> cast(attrs, [:type, :source, :meta, :timestamp, :user_id])
    |> validate_required([:type, :timestamp])
  end

  @doc """
  Converts an AuditEvent back to an Activity struct for rendering.
  """
  def to_activity(%__MODULE__{} = event) do
    %Activity{
      id: event.id,
      type: String.to_atom(event.type),
      source: if(event.source, do: String.to_atom(event.source)),
      reply_to: nil,
      user_id: event.user_id,
      meta: atomize_meta(event.meta),
      timestamp: event.timestamp
    }
  end

  # Convert atom keys in meta to strings for JSON storage
  defp stringify_meta(nil), do: %{}

  defp stringify_meta(meta) when is_map(meta) do
    Map.new(meta, fn {k, v} -> {to_string(k), stringify_value(v)} end)
  end

  defp stringify_value(v) when is_atom(v), do: to_string(v)
  defp stringify_value(v), do: v

  # Convert string keys back to atoms for Activity struct
  defp atomize_meta(nil), do: %{}

  defp atomize_meta(meta) when is_map(meta) do
    Map.new(meta, fn {k, v} -> {String.to_atom(k), v} end)
  end
end
