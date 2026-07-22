defmodule Manfrod.Events.AgentRun do
  @moduledoc """
  Represents a single run of the Retrospector agent.

  Derived from audit events - correlates start/complete/fail events into
  a coherent run with computed fields.

  ## Fields

  - `agent` - `:retrospector`
  - `started_at` - when the run began
  - `ended_at` - when the run ended (nil if still running)
  - `duration_ms` - computed duration in milliseconds (nil if still running)
  - `outcome` - `:success`, `:failure`, or `:running`
  - `intent` - what the agent intended to do (summary)
  - `stats` - outcome statistics from completed event meta
  - `kind` - which schedule triggered the run: `:slipbox_drain` (weekly,
    `RetrospectionWorker`) or `:graph_review` (daily, `GraphReviewWorker`).
    `nil` for runs recorded before this field existed.
  """

  @type outcome :: :success | :failure | :running
  @type kind :: :slipbox_drain | :graph_review | nil

  @type t :: %__MODULE__{
          agent: :retrospector,
          started_at: DateTime.t(),
          ended_at: DateTime.t() | nil,
          duration_ms: non_neg_integer() | nil,
          outcome: outcome(),
          intent: String.t(),
          stats: map(),
          kind: kind()
        }

  @enforce_keys [:agent, :started_at, :outcome, :intent]
  defstruct [
    :agent,
    :started_at,
    :ended_at,
    :duration_ms,
    :outcome,
    :intent,
    :stats,
    :kind
  ]

  @doc """
  Create an AgentRun from a start event and optional end event.

  The start event must be a `retrospection_started` event.
  The end event (if provided) must be the corresponding completed/failed event.
  """
  def from_events(start_event, end_event \\ nil)

  def from_events(%{type: "retrospection_started"} = start, nil) do
    slipbox_count = start.meta["slipbox_count"] || 0
    review_count = start.meta["review_count"] || 0
    kind = parse_kind(start.meta["kind"])

    %__MODULE__{
      agent: :retrospector,
      started_at: start.timestamp,
      ended_at: nil,
      duration_ms: nil,
      outcome: :running,
      intent: intent_text(kind, slipbox_count, review_count),
      stats: %{},
      kind: kind
    }
  end

  def from_events(%{type: "retrospection_started"} = start, end_event) do
    slipbox_count = start.meta["slipbox_count"] || 0
    review_count = start.meta["review_count"] || 0
    kind = parse_kind(start.meta["kind"])

    outcome =
      cond do
        String.ends_with?(end_event.type, "_completed") -> :success
        String.ends_with?(end_event.type, "_failed") -> :failure
        true -> :running
      end

    duration_ms = DateTime.diff(end_event.timestamp, start.timestamp, :millisecond)

    %__MODULE__{
      agent: :retrospector,
      started_at: start.timestamp,
      ended_at: end_event.timestamp,
      duration_ms: duration_ms,
      outcome: outcome,
      intent: intent_text(kind, slipbox_count, review_count),
      stats: end_event.meta || %{},
      kind: kind
    }
  end

  defp parse_kind("graph_review"), do: :graph_review
  defp parse_kind("slipbox_drain"), do: :slipbox_drain
  defp parse_kind(_), do: nil

  defp intent_text(:graph_review, _slipbox_count, review_count) do
    "Deep review of #{review_count} graph nodes (no slipbox)"
  end

  defp intent_text(_kind, slipbox_count, review_count) do
    "Process #{slipbox_count} slipbox nodes, review #{review_count} graph nodes"
  end
end
