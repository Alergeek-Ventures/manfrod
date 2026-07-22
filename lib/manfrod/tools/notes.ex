defmodule Manfrod.Tools.Notes do
  @moduledoc """
  Zettelkasten (notes graph) tools for the live agent: search, fetch,
  create/delete, and link/unlink.
  """

  alias Manfrod.Memory
  alias Manfrod.Memory.PendingOps
  alias Manfrod.Tools.Support
  alias Manfrod.Voyage

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
          ]
        ],
        callback: fn args -> search_notes(user_id, readable_levels, args) end
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

  defp search_notes(user_id, readable_levels, %{query: query}) do
    {:ok, nodes} = Memory.search(user_id, readable_levels, query, limit: 10)

    if Enum.empty?(nodes) do
      {:ok, "No relevant notes found for: #{query}"}
    else
      lines =
        Enum.map(nodes, fn node ->
          linked = Memory.get_node_links(user_id, node.id)
          linked_ids = Enum.map(linked, & &1.id) |> Enum.join(", ")

          if linked_ids == "" do
            "- [#{node.id}] #{node.content}"
          else
            "- [#{node.id}] #{node.content}\n  Linked to: #{linked_ids}"
          end
        end)

      {:ok, "Found #{length(nodes)} notes:\n#{Enum.join(lines, "\n")}"}
    end
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
                "- [#{n.id}] #{n.content}"
              end)

            "Linked notes:\n#{Enum.join(lines, "\n")}"
          end

        {:ok,
         """
         Note [#{node.id}]:
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
