defmodule Manfrod.Tools.Notes do
  @moduledoc """
  Zettelkasten (notes graph) tools for the live agent: search, fetch,
  create/delete, and link/unlink.
  """

  alias Manfrod.Memory
  alias Manfrod.Memory.{Access, PendingOps}
  alias Manfrod.Tools.Support
  alias Manfrod.Voyage

  @timezone "Europe/Warsaw"

  def definitions(%{
        user_id: user_id,
        readable_levels: readable_levels,
        write_access: write_access,
        msg_ctx: msg_ctx
      }) do
    [
      ReqLLM.Tool.new!(
        name: "search_notes",
        description:
          "Search your zettelkasten for relevant notes. Use this when you need to find facts, preferences, or context not in the initial note context.",
        parameter_schema: [
          query: [
            type: :string,
            required: true,
            doc: "Search query - what you want to find"
          ],
          project: [
            type: :string,
            required: false,
            doc:
              "Project name or slug to scope results to (use list_projects to confirm/disambiguate first if unsure). Omit to use the current channel's project, if this channel is mapped to one — otherwise no project scoping is applied."
          ]
        ],
        callback: fn args -> search_notes(user_id, readable_levels, msg_ctx, args) end
      ),
      ReqLLM.Tool.new!(
        name: "list_recent_notes",
        description:
          "List notes in chronological order (newest first), optionally bounded to a date range and/or scoped to one project. Use for activity/project summaries — 'what happened today', 'this week', 'between two dates' — where you need everything in time order, not a relevance search like search_notes.",
        parameter_schema: [
          since: [
            type: :string,
            required: false,
            doc:
              "Only notes on/after this date (YYYY-MM-DD, Europe/Warsaw calendar day). Omit for no lower bound."
          ],
          until: [
            type: :string,
            required: false,
            doc:
              "Only notes on/before this date (YYYY-MM-DD, Europe/Warsaw calendar day). Omit for no upper bound."
          ],
          limit: [type: :integer, required: false, doc: "Max notes to return (default 50)"],
          order: [
            type: :string,
            required: false,
            doc:
              "'desc' (default, newest first) or 'asc' (oldest first — use to find the earliest/oldest notes in a range)"
          ],
          project: [
            type: :string,
            required: false,
            doc:
              "Project name or slug to scope results to (use list_projects to confirm/disambiguate first if unsure). Omit to use the current channel's project, if this channel is mapped to one — otherwise no project scoping is applied."
          ]
        ],
        callback: fn args -> list_recent_notes(readable_levels, msg_ctx, args) end
      ),
      ReqLLM.Tool.new!(
        name: "get_note",
        description:
          "Fetch a specific note by its UUID. Also returns linked notes for context. Use when you have a note ID from the context and want more details or related notes.",
        parameter_schema: [
          id: [
            type: :string,
            required: true,
            doc: "UUID of the note to fetch (e.g., '550e8400-e29b-41d4-a716-446655440000')"
          ]
        ],
        callback: fn args -> get_note(readable_levels, args) end
      ),
      ReqLLM.Tool.new!(
        name: "create_note",
        description:
          "Flag content for the background memory to save as a note (the memory batch does the actual write, deduplicated with passive capture). Use for facts worth remembering.",
        parameter_schema: [
          content: [
            type: :string,
            required: true,
            doc: "The atomic idea or fact (1-2 sentences)"
          ]
        ],
        callback: fn args -> create_note(user_id, write_access, msg_ctx, args) end
      ),
      ReqLLM.Tool.new!(
        name: "delete_note",
        description:
          "Delete a note from your zettelkasten. All links to/from this note are automatically removed.",
        parameter_schema: [
          id: [
            type: :string,
            required: true,
            doc: "UUID of the note to delete"
          ]
        ],
        callback: fn args -> delete_note(user_id, readable_levels, msg_ctx, args) end
      ),
      ReqLLM.Tool.new!(
        name: "link_notes",
        description:
          "Create a link between two notes. Links are undirected - order doesn't matter.",
        parameter_schema: [
          note_a_id: [type: :string, required: true, doc: "First note UUID"],
          note_b_id: [type: :string, required: true, doc: "Second note UUID"]
        ],
        callback: fn args -> link_notes(user_id, readable_levels, msg_ctx, args) end
      ),
      ReqLLM.Tool.new!(
        name: "unlink_notes",
        description: "Remove a link between two notes.",
        parameter_schema: [
          note_a_id: [type: :string, required: true, doc: "First note UUID"],
          note_b_id: [type: :string, required: true, doc: "Second note UUID"]
        ],
        callback: fn args -> unlink_notes(user_id, readable_levels, msg_ctx, args) end
      )
    ]
  end

  defp search_notes(user_id, readable_levels, msg_ctx, %{query: query} = args) do
    case resolve_project(Map.get(args, :project), msg_ctx) do
      {:ok, project_id} ->
        {:ok, nodes} = Memory.search(user_id, readable_levels, query, limit: 10, project_id: project_id)

        if Enum.empty?(nodes) do
          {:ok, "No relevant notes found for: #{query}"}
        else
          lines =
            Enum.map(nodes, fn node ->
              linked = Memory.get_node_links(user_id, node.id)
              linked_ids = Enum.map(linked, & &1.id) |> Enum.join(", ")
              date = note_date(node)

              if linked_ids == "" do
                "- #{date} [#{node.id}] #{node.content}"
              else
                "- #{date} [#{node.id}] #{node.content}\n  Linked to: #{linked_ids}"
              end
            end)

          {:ok, "Found #{length(nodes)} notes:\n#{Enum.join(lines, "\n")}"}
        end

      {:error, :unknown_project} ->
        {:ok, unknown_project_message(Map.get(args, :project))}
    end
  end

  defp list_recent_notes(readable_levels, msg_ctx, args) do
    with {:ok, since_dt} <- parse_date_bound(Map.get(args, :since), :since),
         {:ok, until_dt} <- parse_date_bound(Map.get(args, :until), :until),
         {:ok, project_id} <- resolve_project(Map.get(args, :project), msg_ctx) do
      limit = Map.get(args, :limit, 50)
      order = if Map.get(args, :order) == "asc", do: :asc, else: :desc

      nodes =
        Memory.list_nodes_by_date(readable_levels,
          since: since_dt,
          until: until_dt,
          project_id: project_id,
          limit: limit,
          order: order
        )

      if Enum.empty?(nodes) do
        {:ok, "No notes found in that range."}
      else
        order_label = if order == :asc, do: "oldest first", else: "newest first"

        lines =
          Enum.map(nodes, fn node -> "- #{note_date(node)} [#{node.id}] #{node.content}" end)

        {:ok, "Found #{length(nodes)} notes (#{order_label}):\n#{Enum.join(lines, "\n")}"}
      end
    else
      {:error, :invalid_date} -> {:ok, "Invalid date — use YYYY-MM-DD."}
      {:error, :unknown_project} -> {:ok, unknown_project_message(Map.get(args, :project))}
    end
  end

  # No project named: fall back to the current channel's own project mapping
  # (if any) so a project channel's summary is always scoped to it without
  # the agent having to ask or name it explicitly.
  defp resolve_project(nil, %{channel: channel}) when is_binary(channel) do
    case Access.get_active_mapping(channel) do
      %{project_id: project_id} -> {:ok, project_id}
      nil -> {:ok, nil}
    end
  end

  defp resolve_project(nil, _msg_ctx), do: {:ok, nil}

  defp resolve_project(name, _msg_ctx) when is_binary(name) do
    case Memory.find_project(name) do
      nil -> {:error, :unknown_project}
      project -> {:ok, project.id}
    end
  end

  defp unknown_project_message(name),
    do: "Nie znalazłem projektu \"#{name}\" — sprawdź listę przez list_projects."

  defp parse_date_bound(nil, _edge), do: {:ok, nil}

  defp parse_date_bound(date_str, edge) do
    case Date.from_iso8601(date_str) do
      {:ok, date} ->
        time = if edge == :since, do: ~T[00:00:00], else: ~T[23:59:59]

        naive_utc =
          date
          |> DateTime.new!(time, @timezone)
          |> DateTime.shift_zone!("Etc/UTC")
          |> DateTime.to_naive()

        {:ok, naive_utc}

      {:error, _} ->
        {:error, :invalid_date}
    end
  end

  defp note_date(node) do
    node.inserted_at
    |> DateTime.from_naive!("Etc/UTC")
    |> DateTime.shift_zone!(@timezone)
    |> Calendar.strftime("%Y-%m-%d")
  end

  defp get_note(readable_levels, %{id: id}) do
    case Memory.get_node_accessible(readable_levels, id) do
      nil ->
        {:ok, "Note not found: #{id}"}

      node ->
        linked_nodes = Memory.get_node_links_accessible(readable_levels, node.id)

        linked_content =
          if Enum.empty?(linked_nodes) do
            "No linked notes."
          else
            lines =
              Enum.map(linked_nodes, fn n ->
                "- #{note_date(n)} [#{n.id}] #{n.content}"
              end)

            "Linked notes:\n#{Enum.join(lines, "\n")}"
          end

        {:ok,
         """
         Note [#{node.id}] (#{note_date(node)}):
         #{node.content}

         #{linked_content}
         """}
    end
  end

  # Flags the current message for the memory batch instead of writing directly,
  # so the passive Classifier stays the single writer (named, deduplicated notes).
  defp create_note(user_id, write_access, msg_ctx, %{content: content}) do
    case Support.flaggable(msg_ctx) do
      {:ok, channel_id, ts} ->
        PendingOps.flag_message(channel_id, ts, "create_memory", %{content: content})
        {:ok, "Zaznaczyłem do zapamiętania — pamięć w tle zapisze notatkę."}

      :error ->
        create_note_direct(user_id, write_access, content)
    end
  end

  defp create_note_direct(user_id, write_access, content) do
    case Voyage.embed_query(content) do
      {:ok, embedding} ->
        case Memory.create_node(user_id, write_access, %{content: content, embedding: embedding}) do
          {:ok, node} ->
            {:ok, "Created note in slipbox: #{node.id}"}

          {:error, changeset} ->
            {:ok, "Failed to create note: #{inspect(changeset.errors)}"}
        end

      {:error, reason} ->
        {:ok, "Failed to generate embedding: #{inspect(reason)}"}
    end
  end

  defp delete_note(user_id, readable_levels, msg_ctx, %{id: id}) do
    with {:ok, channel_id, ts} <- Support.flaggable(msg_ctx),
         node when not is_nil(node) <- Memory.get_node_accessible(readable_levels, id) do
      PendingOps.add_op(channel_id, ts, {:delete, %{node_id: id, user_id: user_id}})
      {:ok, "Zaznaczyłem notatkę do usunięcia: #{id}"}
    else
      :error -> delete_note_direct(user_id, readable_levels, id)
      nil -> {:ok, "Note not found: #{id}"}
    end
  end

  defp delete_note_direct(user_id, readable_levels, id) do
    case Memory.get_node_accessible(readable_levels, id) do
      nil ->
        {:ok, "Note not found: #{id}"}

      _node ->
        case Memory.delete_node(user_id, id) do
          {:ok, _node} -> {:ok, "Deleted note: #{id}"}
          {:error, :not_found} -> {:ok, "Note not found or not yours: #{id}"}
        end
    end
  end

  defp link_notes(user_id, readable_levels, msg_ctx, %{note_a_id: a, note_b_id: b}) do
    case Support.flaggable(msg_ctx) do
      {:ok, channel_id, ts} ->
        if Memory.get_node_accessible(readable_levels, a) &&
             Memory.get_node_accessible(readable_levels, b) do
          PendingOps.add_op(channel_id, ts, {:link, %{a: a, b: b, user_id: user_id}})
          {:ok, "Zaznaczyłem połączenie notatek: #{a} <-> #{b}"}
        else
          {:ok, "One or both notes not found or not accessible"}
        end

      :error ->
        link_notes_direct(user_id, readable_levels, a, b)
    end
  end

  defp link_notes_direct(user_id, readable_levels, a, b) do
    node_a = Memory.get_node_accessible(readable_levels, a)
    node_b = Memory.get_node_accessible(readable_levels, b)

    if node_a && node_b do
      case Memory.create_link(user_id, a, b) do
        {:ok, _link} -> {:ok, "Linked #{a} <-> #{b}"}
        {:error, changeset} -> {:ok, "Failed to create link: #{inspect(changeset.errors)}"}
      end
    else
      {:ok, "One or both notes not found or not accessible"}
    end
  end

  defp unlink_notes(user_id, readable_levels, msg_ctx, %{note_a_id: a, note_b_id: b}) do
    case Support.flaggable(msg_ctx) do
      {:ok, channel_id, ts} ->
        if Memory.get_node_accessible(readable_levels, a) &&
             Memory.get_node_accessible(readable_levels, b) do
          PendingOps.add_op(channel_id, ts, {:unlink, %{a: a, b: b, user_id: user_id}})
          {:ok, "Zaznaczyłem rozłączenie notatek: #{a} <-> #{b}"}
        else
          {:ok, "One or both notes not found or not accessible"}
        end

      :error ->
        unlink_notes_direct(user_id, readable_levels, a, b)
    end
  end

  defp unlink_notes_direct(user_id, readable_levels, a, b) do
    node_a = Memory.get_node_accessible(readable_levels, a)
    node_b = Memory.get_node_accessible(readable_levels, b)

    if node_a && node_b do
      case Memory.delete_link(user_id, a, b) do
        {:ok, _link} -> {:ok, "Unlinked #{a} <-> #{b}"}
        {:error, :not_found} -> {:ok, "Link not found: #{a} <-> #{b}"}
      end
    else
      {:ok, "One or both notes not found or not accessible"}
    end
  end
end
