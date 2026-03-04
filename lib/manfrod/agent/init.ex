defmodule Manfrod.Agent.Init do
  @moduledoc """
  Shared initialization for agents.

  Builds rich context from:
  - Soul node (shared entrypoint)
  - Linked notes (workspace)
  - Recent audit events (delta since last run)
  - Random graph sample (serendipity)

  This enables agents to understand "what happened" and make informed decisions.
  """

  alias Manfrod.Events.Store
  alias Manfrod.Memory

  @doc """
  Build context for an agent run.

  Returns a map with:
  - `:soul` - the soul node (entrypoint)
  - `:linked_notes` - notes linked to soul
  - `:recent_events` - audit events since given timestamp
  - `:graph_sample` - random nodes from the graph

  ## Options

    * `:since` - timestamp for events delta (default: 24 hours ago)
    * `:event_limit` - max events to fetch (default: 100)
    * `:event_types` - filter event types (default: all)
    * `:sample_size` - random graph sample size (default: 5)
  """
  def build_context(user_id, opts \\ []) do
    since = Keyword.get(opts, :since, default_since())
    event_limit = Keyword.get(opts, :event_limit, 100)
    event_types = Keyword.get(opts, :event_types, nil)
    sample_size = Keyword.get(opts, :sample_size, 5)

    soul = Memory.get_soul(user_id)

    linked_notes =
      if soul do
        Memory.get_node_links(user_id, soul.id)
      else
        []
      end

    event_opts =
      [limit: event_limit]
      |> then(fn opts ->
        if event_types, do: Keyword.put(opts, :types, event_types), else: opts
      end)

    recent_events = Store.get_events_since(since, event_opts)
    graph_sample = Memory.get_random_nodes(user_id, sample_size)

    %{
      soul: soul,
      linked_notes: linked_notes,
      recent_events: recent_events,
      graph_sample: graph_sample,
      since: since
    }
  end

  @doc """
  Build the full system prompt for an agent.

  Combines context with agent-specific instructions. Each agent calls this
  with their own options and appends their capabilities/instructions.

  ## Options

  Same as `build_context/1`, plus:
    * `:include_events` - whether to include events (default: true)
    * `:include_samples` - whether to include random graph samples (default: true)

  ## Examples

      # Retrospector gets full context
      Init.build_system_prompt()

      # Assistant gets just soul + linked notes
      Init.build_system_prompt(include_events: false, include_samples: false)
  """
  def build_system_prompt(user_id, opts \\ []) do
    include_events = Keyword.get(opts, :include_events, true)
    include_samples = Keyword.get(opts, :include_samples, true)

    # Adjust opts to skip unwanted sections
    context_opts =
      opts
      |> Keyword.put_new(:event_limit, if(include_events, do: 100, else: 0))
      |> Keyword.put_new(:sample_size, if(include_samples, do: 5, else: 0))

    ctx = build_context(user_id, context_opts)
    format_context(ctx)
  end

  @doc """
  Format context into a string suitable for LLM prompt injection.
  """
  def format_context(%{} = ctx) do
    sections = [
      format_soul(ctx.soul),
      format_linked_notes(ctx.linked_notes),
      format_recent_events(ctx.recent_events),
      format_graph_sample(ctx.graph_sample)
    ]

    sections
    |> Enum.reject(&is_nil/1)
    |> Enum.join("\n\n")
  end

  # Private

  defp default_since do
    DateTime.utc_now()
    |> DateTime.add(-24, :hour)
  end

  defp format_soul(nil), do: nil

  defp format_soul(soul) do
    """
    [Soul - Entrypoint to your notes graph]
    #{soul.content}
    """
  end

  defp format_linked_notes([]), do: nil

  defp format_linked_notes(notes) do
    items =
      notes
      |> Enum.map(fn n -> "- [#{n.id}] #{String.slice(n.content, 0, 200)}" end)
      |> Enum.join("\n")

    """
    [Linked Notes - expanding the entrypoint]
    #{items}
    """
  end

  defp format_recent_events([]), do: nil

  defp format_recent_events(events) do
    # Group by type and summarize
    by_type =
      events
      |> Enum.group_by(& &1.type)
      |> Enum.map(fn {type, items} -> "- #{type}: #{length(items)} events" end)
      |> Enum.join("\n")

    # Show last few detailed events
    recent =
      events
      |> Enum.take(-10)
      |> Enum.map(fn e ->
        meta_preview =
          e.meta
          |> inspect(limit: 3, printable_limit: 50)
          |> String.slice(0, 100)

        "- [#{e.timestamp}] #{e.type}: #{meta_preview}"
      end)
      |> Enum.join("\n")

    """
    [Recent Events Summary - #{length(events)} total]
    #{by_type}

    [Last 10 Events]
    #{recent}
    """
  end

  defp format_graph_sample([]), do: nil

  defp format_graph_sample(nodes) do
    items =
      nodes
      |> Enum.map(fn n -> "- [#{n.id}] #{String.slice(n.content, 0, 150)}" end)
      |> Enum.join("\n")

    """
    [Random Graph Sample]
    #{items}
    """
  end
end
