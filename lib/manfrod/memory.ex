defmodule Manfrod.Memory do
  @moduledoc """
  Slipbox-style memory: nodes + undirected links.
  Hybrid retrieval via pgvector (semantic) + ParadeDB BM25 (keyword).

  Also manages conversations and messages for provenance tracking.

  Single shared knowledge graph: nodes carry an `access` array and every
  read path filters through `Access.dynamic_where/1`. `user_id` on nodes is
  provenance (who said it), not access control.

  All mutating operations emit events to the event bus for audit visibility.
  """

  import Ecto.Query
  import Pgvector.Ecto.Query
  import Paradex

  alias Manfrod.Events
  alias Manfrod.Repo
  alias Manfrod.Voyage

  alias Manfrod.Memory.{
    Access,
    Conversation,
    Message,
    Node,
    Link,
    QueryExpander,
    RecurringReminder
  }

  # Relevance threshold for filtering search results (cosine distance)
  # Lower = more strict, higher = more permissive
  # Cosine distance ranges from 0 (identical) to 2 (opposite)
  @relevance_threshold 0.4

  # RRF constant (k) - higher values give more weight to lower-ranked results
  @rrf_k 60

  # --- Messages ---

  @doc """
  Create a pending message (conversation_id = nil) for a user.
  """
  def create_message(user_id, attrs) do
    %Message{user_id: user_id}
    |> Message.changeset(attrs)
    |> Repo.insert()
  end

  @doc """
  Get all pending messages for a user and session (not yet assigned to a conversation).
  Ordered by received_at ascending.
  """
  def get_pending_messages(user_id, session_key) do
    Message
    |> where(
      [m],
      m.user_id == ^user_id and m.session_key == ^session_key and is_nil(m.conversation_id)
    )
    |> order_by([m], asc: m.received_at)
    |> Repo.all()
  end

  # --- Conversations ---

  @doc """
  Close a conversation for a user session: create conversation record and link
  all pending messages for that session.

  Returns {:ok, conversation} or {:error, changeset}.

  Expects attrs with :summary key. started_at and ended_at are computed from messages.
  The session_key is stored on the conversation record.
  """
  def close_conversation(user_id, session_key, attrs) do
    Repo.transaction(fn ->
      messages = get_pending_messages(user_id, session_key)

      if messages == [] do
        Repo.rollback(:no_pending_messages)
      end

      started_at = messages |> List.first() |> Map.get(:received_at)
      ended_at = messages |> List.last() |> Map.get(:received_at)

      conversation_attrs =
        attrs
        |> Map.put(:started_at, started_at)
        |> Map.put(:ended_at, ended_at)
        |> Map.put(:session_key, session_key)

      case %Conversation{user_id: user_id}
           |> Conversation.changeset(conversation_attrs)
           |> Repo.insert() do
        {:ok, conversation} ->
          # Link all pending messages to this conversation
          message_ids = Enum.map(messages, & &1.id)

          {_count, _} =
            from(m in Message, where: m.id in ^message_ids)
            |> Repo.update_all(set: [conversation_id: conversation.id])

          conversation

        {:error, changeset} ->
          Repo.rollback(changeset)
      end
    end)
  end

  @doc """
  Get a conversation with its messages preloaded, scoped to a user.
  """
  def get_conversation_with_messages(user_id, conversation_id) do
    Conversation
    |> where([c], c.user_id == ^user_id and c.id == ^conversation_id)
    |> preload(:messages)
    |> Repo.one()
  end

  # --- Soul ---

  @doc """
  Check if the user's zettelkasten has a soul (any nodes exist).
  """
  def has_soul?(user_id) do
    Repo.exists?(from(n in Node, where: n.user_id == ^user_id))
  end

  @doc """
  Get the soul for a user - the first node by insertion time.
  Returns nil if no nodes exist for the user.
  """
  def get_soul(user_id \\ nil) do
    scoped_nodes_query(user_id)
    |> order_by([n], asc: n.inserted_at)
    |> limit(1)
    |> Repo.one()
  end

  # --- Nodes ---

  def create_node(user_id, access, attrs) when is_list(access) do
    result =
      %Node{user_id: user_id}
      |> Node.changeset(Map.put(attrs, :access, access))
      |> Repo.insert()

    case result do
      {:ok, node} ->
        Events.broadcast(:memory_node_created, %{
          user_id: user_id,
          source: :memory,
          meta: %{
            node_id: node.id,
            access: access,
            content_preview: String.slice(node.content, 0, 100)
          }
        })

        {:ok, node}

      error ->
        error
    end
  end

  def list_nodes(user_id, opts \\ []) do
    Node
    |> where([n], n.user_id == ^user_id)
    |> order_by([n], desc: n.inserted_at)
    |> limit(^Keyword.get(opts, :limit, 100))
    |> Repo.all()
  end

  @doc """
  Get all nodes in the slipbox (unprocessed) for a user.
  """
  def get_slipbox_nodes(user_id, opts \\ []) do
    Node
    |> where([n], n.user_id == ^user_id and is_nil(n.processed_at))
    |> order_by([n], asc: n.inserted_at)
    |> limit(^Keyword.get(opts, :limit, 100))
    |> Repo.all()
  end

  @doc """
  Return distinct access buckets that have unprocessed slipbox nodes.
  Used by Retrospector to iterate per-bucket instead of per-user.
  """
  def list_slipbox_access_buckets do
    from(n in Node,
      where: is_nil(n.processed_at),
      select: n.access,
      distinct: true
    )
    |> Repo.all()
  end

  @doc """
  Get unprocessed slipbox nodes with a specific access array (for per-bucket retrospection).
  """
  def get_slipbox_nodes_by_access(access, opts \\ []) do
    from(n in Node,
      where: is_nil(n.processed_at) and n.access == ^access,
      order_by: [asc: n.inserted_at],
      limit: ^Keyword.get(opts, :limit, 100)
    )
    |> Repo.all()
  end

  @doc """
  Get a node by ID, scoped to a user (provenance check only).
  """
  def get_node(user_id, id) do
    Node
    |> where([n], n.user_id == ^user_id and n.id == ^id)
    |> Repo.one()
  end

  @doc """
  Get a node by ID filtered by readable access levels (single-graph access check).
  Returns nil if node doesn't exist or caller can't read it.
  """
  def get_node_accessible(readable_levels, id) do
    Node
    |> where([n], n.id == ^id)
    |> where(^Access.dynamic_where(readable_levels))
    |> Repo.one()
  end

  @doc """
  Mark a node as processed (integrated into the graph), scoped to a user.
  """
  def mark_processed(user_id, node_id) do
    now = DateTime.utc_now() |> DateTime.truncate(:second)

    from(n in Node, where: n.user_id == ^user_id and n.id == ^node_id)
    |> Repo.update_all(set: [processed_at: now])

    Events.broadcast(:memory_node_processed, %{
      user_id: user_id,
      source: :memory,
      meta: %{node_id: node_id}
    })

    :ok
  end

  @doc """
  Update a node's content and re-embed it, scoped to a user.
  Preserves the node's ID, links, and provenance.
  Returns {:ok, node} or {:error, :not_found} or {:error, changeset}.
  """
  def update_node(user_id, node_id, attrs) do
    case get_node(user_id, node_id) do
      nil ->
        {:error, :not_found}

      node ->
        result =
          node
          |> Node.changeset(attrs)
          |> Repo.update()

        case result do
          {:ok, updated} ->
            Events.broadcast(:memory_node_updated, %{
              user_id: user_id,
              source: :memory,
              meta: %{
                node_id: updated.id,
                content_preview: String.slice(updated.content, 0, 100)
              }
            })

            {:ok, updated}

          error ->
            error
        end
    end
  end

  def update_node_accessible(readable_levels, node_id, attrs) do
    case get_node_accessible(readable_levels, node_id) do
      nil ->
        {:error, :not_found}

      node ->
        result =
          node
          |> Node.changeset(attrs)
          |> Repo.update()

        case result do
          {:ok, updated} ->
            Events.broadcast(:memory_node_updated, %{
              user_id: updated.user_id,
              source: :memory,
              meta: %{
                node_id: updated.id,
                content_preview: String.slice(updated.content, 0, 100)
              }
            })

            {:ok, updated}

          error ->
            error
        end
    end
  end

  @doc """
  Delete a node and all its links (cascade), scoped to a user.
  Returns {:ok, node} or {:error, :not_found}.
  """
  def delete_node(user_id, node_id) do
    case get_node(user_id, node_id) do
      nil ->
        {:error, :not_found}

      node ->
        # Delete all links involving this node
        from(l in Link,
          where: l.node_a_id == ^node_id or l.node_b_id == ^node_id
        )
        |> Repo.delete_all()

        # Delete the node
        Repo.delete(node)

        Events.broadcast(:memory_node_deleted, %{
          user_id: user_id,
          source: :memory,
          meta: %{node_id: node_id}
        })

        {:ok, node}
    end
  end

  def delete_node_accessible(readable_levels, node_id) do
    case get_node_accessible(readable_levels, node_id) do
      nil ->
        {:error, :not_found}

      node ->
        from(l in Link,
          where: l.node_a_id == ^node_id or l.node_b_id == ^node_id
        )
        |> Repo.delete_all()

        Repo.delete(node)

        Events.broadcast(:memory_node_deleted, %{
          user_id: node.user_id,
          source: :memory,
          meta: %{node_id: node_id}
        })

        {:ok, node}
    end
  end

  # --- Links ---

  def create_link(user_id, node_a_id, node_b_id, opts \\ []) do
    context = Keyword.get(opts, :context)

    attrs =
      %{node_a_id: node_a_id, node_b_id: node_b_id}
      |> then(fn a -> if context, do: Map.put(a, :context, context), else: a end)

    result =
      %Link{}
      |> Link.changeset(attrs)
      |> Repo.insert(on_conflict: :nothing)

    case result do
      {:ok, link} ->
        Events.broadcast(:memory_link_created, %{
          user_id: user_id,
          source: :memory,
          meta: %{node_a_id: link.node_a_id, node_b_id: link.node_b_id}
        })

        {:ok, link}

      error ->
        error
    end
  end

  @doc """
  Delete a link between two nodes, scoped to a user.
  Returns {:ok, link} or {:error, :not_found}.

  Verifies that both nodes belong to the user before deleting.
  """
  def delete_link(user_id, node_a_id, node_b_id) do
    # Normalize order (same logic as Link changeset)
    {a, b} = if node_a_id < node_b_id, do: {node_a_id, node_b_id}, else: {node_b_id, node_a_id}

    # Verify both nodes belong to the user
    user_node_ids =
      from(n in Node, where: n.user_id == ^user_id and n.id in ^[a, b], select: n.id)
      |> Repo.all()
      |> MapSet.new()

    if MapSet.size(user_node_ids) == 2 do
      case Repo.get_by(Link, node_a_id: a, node_b_id: b) do
        nil ->
          {:error, :not_found}

        link ->
          Repo.delete(link)

          Events.broadcast(:memory_link_deleted, %{
            user_id: user_id,
            source: :memory,
            meta: %{node_a_id: a, node_b_id: b}
          })

          {:ok, link}
      end
    else
      {:error, :not_found}
    end
  end

  @doc """
  Get all linked nodes for a given node, scoped to a user.
  Returns a list of nodes that are directly connected.
  """
  def get_node_links(user_id, node_id) do
    from(n in Node,
      join: l in Link,
      on:
        (l.node_a_id == ^node_id and l.node_b_id == n.id) or
          (l.node_b_id == ^node_id and l.node_a_id == n.id),
      where: n.user_id == ^user_id,
      distinct: n.id
    )
    |> Repo.all()
  end

  @doc """
  Get linked nodes filtered by readable access levels.
  """
  def get_node_links_accessible(readable_levels, node_id) do
    from(n in Node,
      join: l in Link,
      on:
        (l.node_a_id == ^node_id and l.node_b_id == n.id) or
          (l.node_b_id == ^node_id and l.node_a_id == n.id),
      where: ^Access.dynamic_where(readable_levels),
      distinct: n.id
    )
    |> Repo.all()
  end

  @doc """
  Get all linked nodes for a given node, with link context, scoped to a user.
  Returns a list of `{node, context}` tuples where context may be nil.
  """
  def get_node_links_with_context(user_id, node_id) do
    from(n in Node,
      join: l in Link,
      on:
        (l.node_a_id == ^node_id and l.node_b_id == n.id) or
          (l.node_b_id == ^node_id and l.node_a_id == n.id),
      where: n.user_id == ^user_id,
      select: {n, l.context},
      distinct: n.id
    )
    |> Repo.all()
  end

  @doc """
  Get a random sample of processed nodes from the user's graph.
  """
  def get_random_nodes(user_id, limit \\ 10) do
    Node
    |> where([n], n.user_id == ^user_id and not is_nil(n.processed_at))
    |> order_by(fragment("RANDOM()"))
    |> limit(^limit)
    |> Repo.all()
  end

  # --- Graph Health ---

  @doc """
  Get graph health statistics — for one user (provenance) or the whole
  shared graph when called without arguments.

  Returns a map with:
    * `:total_nodes` - Total number of nodes
    * `:total_links` - Total number of links
    * `:slipbox_count` - Nodes not yet processed
    * `:orphan_count` - Processed nodes with 0 links
    * `:weakly_connected_count` - Processed nodes with exactly 1 link
    * `:link_to_note_ratio` - Total links / total nodes (0.0 if no nodes)
  """
  def graph_stats(user_id \\ nil) do
    scoped_nodes = scoped_nodes_query(user_id)
    total_nodes = Repo.aggregate(scoped_nodes, :count)

    scoped_node_ids = from(n in scoped_nodes, select: n.id)

    total_links =
      from(l in Link,
        where:
          l.node_a_id in subquery(scoped_node_ids) and l.node_b_id in subquery(scoped_node_ids)
      )
      |> Repo.aggregate(:count)

    slipbox_count =
      from(n in scoped_nodes, where: is_nil(n.processed_at))
      |> Repo.aggregate(:count)

    # Orphans: processed nodes with 0 links
    orphan_count =
      from(n in scoped_nodes,
        where: not is_nil(n.processed_at),
        left_join: la in Link,
        on: la.node_a_id == n.id,
        left_join: lb in Link,
        on: lb.node_b_id == n.id,
        where: is_nil(la.id) and is_nil(lb.id),
        select: count(n.id)
      )
      |> Repo.one()

    # Weakly connected: processed nodes with exactly 1 link
    weakly_connected_count =
      from(n in scoped_nodes,
        where: not is_nil(n.processed_at),
        left_join: la in Link,
        on: la.node_a_id == n.id,
        left_join: lb in Link,
        on: lb.node_b_id == n.id,
        group_by: n.id,
        having: count(la.id, :distinct) + count(lb.id, :distinct) == 1,
        select: n.id
      )
      |> Repo.all()
      |> length()

    link_to_note_ratio =
      if total_nodes > 0,
        do: Float.round(total_links / total_nodes, 2),
        else: 0.0

    %{
      total_nodes: total_nodes,
      total_links: total_links,
      slipbox_count: slipbox_count,
      orphan_count: orphan_count,
      weakly_connected_count: weakly_connected_count,
      link_to_note_ratio: link_to_note_ratio
    }
  end

  defp scoped_nodes_query(nil), do: from(n in Node)
  defp scoped_nodes_query(user_id), do: from(n in Node, where: n.user_id == ^user_id)

  @doc """
  Get processed nodes with 0 links (orphans) for a user.
  """
  def get_orphan_nodes(user_id, opts \\ []) do
    limit = Keyword.get(opts, :limit, 25)

    from(n in Node,
      where: n.user_id == ^user_id and not is_nil(n.processed_at),
      left_join: la in Link,
      on: la.node_a_id == n.id,
      left_join: lb in Link,
      on: lb.node_b_id == n.id,
      where: is_nil(la.id) and is_nil(lb.id),
      order_by: [asc: n.inserted_at],
      limit: ^limit
    )
    |> Repo.all()
  end

  @doc """
  Get processed nodes with exactly 1 link (weakly connected) for a user.
  """
  def get_weakly_connected_nodes(user_id, opts \\ []) do
    limit = Keyword.get(opts, :limit, 25)

    from(n in Node,
      where: n.user_id == ^user_id and not is_nil(n.processed_at),
      left_join: la in Link,
      on: la.node_a_id == n.id,
      left_join: lb in Link,
      on: lb.node_b_id == n.id,
      group_by: n.id,
      having: count(la.id, :distinct) + count(lb.id, :distinct) == 1,
      order_by: [asc: n.inserted_at],
      limit: ^limit
    )
    |> Repo.all()
  end

  @doc """
  Get the oldest processed nodes for a user (stalest, least recently created).
  """
  def get_stalest_nodes(user_id, opts \\ []) do
    limit = Keyword.get(opts, :limit, 25)

    Node
    |> where([n], n.user_id == ^user_id and not is_nil(n.processed_at))
    |> order_by([n], asc: n.inserted_at)
    |> limit(^limit)
    |> Repo.all()
  end

  # --- Graph Visualization ---

  @doc """
  Get the whole graph for visualization — single shared graph across all users.

  Returns a map with nodes and edges suitable for graph rendering.

  ## Options

    * `:filter` - Filter nodes: `:all` (default), `:processed`, or `:slipbox`
    * `:access_level` - Optional access level used to scope the displayed subgraph
  """
  def get_graph_data(opts \\ []) do
    filter = Keyword.get(opts, :filter, :all)
    access_level = Keyword.get(opts, :access_level)

    # Fetch nodes based on filter
    nodes_query =
      case filter do
        :processed ->
          from(n in Node, where: not is_nil(n.processed_at))

        :slipbox ->
          from(n in Node, where: is_nil(n.processed_at))

        :all ->
          from(n in Node)
      end

    nodes_query =
      if access_level do
        where(nodes_query, ^Access.dynamic_where([access_level]))
      else
        nodes_query
      end

    nodes = Repo.all(nodes_query)
    node_ids = Enum.map(nodes, & &1.id) |> MapSet.new()

    # Count links per node
    link_counts =
      from(l in Link,
        select: {l.node_a_id, l.node_b_id}
      )
      |> Repo.all()
      |> Enum.flat_map(fn {a, b} -> [{a, 1}, {b, 1}] end)
      |> Enum.reduce(%{}, fn {id, count}, acc ->
        Map.update(acc, id, count, &(&1 + count))
      end)

    # Fetch edges (only between visible nodes)
    edges =
      from(l in Link,
        where:
          l.node_a_id in ^MapSet.to_list(node_ids) and l.node_b_id in ^MapSet.to_list(node_ids),
        select: %{source: l.node_a_id, target: l.node_b_id}
      )
      |> Repo.all()

    # Transform nodes for visualization
    nodes_data =
      Enum.map(nodes, fn node ->
        %{
          id: node.id,
          content: node.content,
          content_preview: String.slice(node.content || "", 0, 100),
          processed: not is_nil(node.processed_at),
          link_count: Map.get(link_counts, node.id, 0),
          inserted_at: node.inserted_at
        }
      end)

    %{nodes: nodes_data, edges: edges}
  end

  # --- Hybrid Search with Query Expansion ---

  @doc """
  Hybrid retrieval with query expansion and reranking, scoped to a user.

  1. Expands the query into multiple search queries using LLM
  2. Runs vector + BM25 search for each expanded query in parallel
  3. Merges results using Reciprocal Rank Fusion (RRF)
  4. Reranks top candidates using Voyage reranker
  5. Filters by relevance threshold
  6. Expands with 1-hop links

  Returns `{:ok, nodes}` where nodes is a list of Node structs.

  ## Options

    * `:limit` - Maximum number of results (default: 10)
    * `:expand_query` - Whether to use query expansion (default: true)
    * `:rerank` - Whether to use Voyage reranker (default: true)
  """
  def search(user_id, readable_levels, query_text, opts \\ []) do
    limit = Keyword.get(opts, :limit, 10)
    expand_query? = Keyword.get(opts, :expand_query, true)
    rerank? = Keyword.get(opts, :rerank, true)

    # Step 1: Query expansion (always succeeds with fallback to original)
    {:ok, queries} =
      if expand_query? do
        QueryExpander.expand(query_text)
      else
        {:ok, [query_text]}
      end

    # Step 2: Parallel search for each query
    search_tasks =
      Enum.flat_map(queries, fn query ->
        [
          Task.async(fn ->
            {:vector, query, search_vector(user_id, readable_levels, query, limit)}
          end),
          Task.async(fn ->
            {:bm25, query, search_bm25(user_id, readable_levels, query, limit)}
          end)
        ]
      end)

    search_results = Task.await_many(search_tasks, :infinity)

    # Step 3: Collect results by type and merge with RRF
    vector_results =
      search_results
      |> Enum.filter(fn {type, _, _} -> type == :vector end)
      |> Enum.flat_map(fn {_, _, results} -> results end)

    bm25_results =
      search_results
      |> Enum.filter(fn {type, _, _} -> type == :bm25 end)
      |> Enum.flat_map(fn {_, _, results} -> results end)

    # RRF merge - combine vector and BM25 results
    merged = rrf_merge([vector_results, bm25_results])

    # Step 4: Rerank top candidates using Voyage (if enabled and we have results)
    {reranked, rerank_scores} =
      if rerank? and length(merged) > 1 do
        rerank_nodes(query_text, merged, limit * 2)
      else
        {merged, []}
      end

    # Step 5: Filter by relevance threshold
    # Only keep nodes where at least one search returned them with good distance
    min_distances = compute_min_distances(vector_results)

    filtered =
      reranked
      |> Enum.filter(fn node ->
        case Map.get(min_distances, node.id) do
          # BM25-only results pass through
          nil -> true
          distance -> distance <= @relevance_threshold
        end
      end)
      |> Enum.take(limit)

    # Step 6: Expand with 1-hop links
    results = expand_with_links(filtered, readable_levels, limit * 2)

    # Broadcast with verbose stats for logging
    Events.broadcast(:memory_searched, %{
      user_id: user_id,
      source: :memory,
      meta: %{
        query: query_text,
        expanded_queries: queries,
        rerank_scores: rerank_scores,
        stats: %{
          vector: length(vector_results),
          bm25: length(bm25_results),
          merged: length(merged),
          reranked: length(reranked),
          filtered: length(filtered),
          final: length(results),
          relevance_threshold: @relevance_threshold,
          rerank_enabled: rerank?,
          rerank_ran: rerank? and length(merged) > 1,
          expand_query_enabled: expand_query?
        }
      }
    })

    {:ok, results}
  end

  @doc """
  Search using only vector similarity (no query expansion), scoped to a user.
  Returns `[{node, distance}]` tuples sorted by distance ascending.
  """
  def search_vector(user_id, readable_levels, query_text, limit \\ 10) do
    case Manfrod.Voyage.embed_query(query_text) do
      {:ok, embedding} ->
        vector_search_with_distance(user_id, readable_levels, embedding, limit)

      {:error, _} ->
        []
    end
  end

  @doc """
  Search using only BM25 keyword matching, filtered by readable access levels.
  Returns list of nodes sorted by BM25 score descending.
  """
  def search_bm25(user_id, readable_levels, query_text, limit \\ 10) do
    bm25_search(user_id, readable_levels, query_text, limit)
  end

  # Vector search returning {node, distance} tuples, filtered by access only (single graph)
  defp vector_search_with_distance(_user_id, readable_levels, embedding, limit) do
    vec = Pgvector.new(embedding)

    from(n in Node,
      where: not is_nil(n.embedding),
      where: ^Access.dynamic_where(readable_levels),
      select: {n, cosine_distance(n.embedding, ^vec)},
      order_by: cosine_distance(n.embedding, ^vec),
      limit: ^limit
    )
    |> Repo.all()
  end

  defp bm25_search(_user_id, readable_levels, query_text, limit) do
    from(n in Node,
      select: {n, score(n.id)},
      where: n.id ~> match("content", ^query_text),
      where: ^Access.dynamic_where(readable_levels),
      order_by: [desc: score()],
      limit: ^limit
    )
    |> Repo.all()
    |> Enum.map(fn {node, _score} -> node end)
  end

  # Compute minimum distance per node from vector results
  defp compute_min_distances(vector_results) do
    vector_results
    |> Enum.reduce(%{}, fn {node, distance}, acc ->
      Map.update(acc, node.id, distance, &min(&1, distance))
    end)
  end

  # Rerank nodes using Voyage reranker
  # Returns {reordered_nodes, rerank_scores} where rerank_scores contains scoring details
  defp rerank_nodes(query, nodes, top_k) do
    # Take top candidates for reranking (limit API call size)
    candidates = Enum.take(nodes, top_k)

    # Extract content for reranking
    documents = Enum.map(candidates, & &1.content)

    case Voyage.rerank(query, documents, top_k: top_k) do
      {:ok, rankings} ->
        # Rankings come as [%{index: i, relevance_score: score}, ...] sorted by score
        # Map back to nodes in new order, preserving scores for logging
        reordered_with_scores =
          Enum.map(rankings, fn %{index: idx, relevance_score: score} ->
            node = Enum.at(candidates, idx)
            {node, score}
          end)

        reordered_nodes = Enum.map(reordered_with_scores, fn {node, _score} -> node end)

        rerank_scores =
          Enum.map(reordered_with_scores, fn {node, score} ->
            %{
              node_id: node.id,
              score: score,
              content_preview: String.slice(node.content || "", 0, 60)
            }
          end)

        {reordered_nodes, rerank_scores}

      {:error, _reason} ->
        # On reranker failure, fall back to original order with empty scores
        {candidates, []}
    end
  end

  @doc """
  Reciprocal Rank Fusion - merges multiple ranked lists into one.

  Each input list can be either:
  - List of nodes (from BM25)
  - List of {node, score} tuples (from vector search)

  Returns a list of nodes sorted by combined RRF score.
  """
  def rrf_merge(ranked_lists) do
    # Normalize all lists to just nodes while tracking ranks
    ranked_lists
    |> Enum.with_index()
    |> Enum.flat_map(fn {list, _list_idx} ->
      list
      # Ranks start at 1
      |> Enum.with_index(1)
      |> Enum.map(fn {item, rank} ->
        node = normalize_to_node(item)
        {node.id, node, rank}
      end)
    end)
    |> Enum.group_by(fn {id, _node, _rank} -> id end)
    |> Enum.map(fn {_id, entries} ->
      # Get the node from first entry
      {_, node, _} = hd(entries)

      # Sum RRF scores across all lists
      rrf_score =
        entries
        |> Enum.map(fn {_, _, rank} -> 1.0 / (@rrf_k + rank) end)
        |> Enum.sum()

      {node, rrf_score}
    end)
    |> Enum.sort_by(fn {_node, score} -> score end, :desc)
    |> Enum.map(fn {node, _score} -> node end)
  end

  defp normalize_to_node({node, _score}), do: node
  defp normalize_to_node(node), do: node

  defp expand_with_links([], _readable_levels, _max), do: []

  defp expand_with_links(nodes, readable_levels, max) do
    ids = Enum.map(nodes, & &1.id)

    linked =
      from(n in Node,
        join: l in Link,
        on:
          (l.node_a_id in ^ids and l.node_b_id == n.id) or
            (l.node_b_id in ^ids and l.node_a_id == n.id),
        where: ^Access.dynamic_where(readable_levels),
        distinct: n.id
      )
      |> Repo.all()

    (nodes ++ linked)
    |> Enum.uniq_by(& &1.id)
    |> Enum.take(max)
  end

  # --- Recurring Reminders ---

  @doc """
  List recurring reminders for a user.

  ## Options

    * `:enabled` - Filter by enabled status (true/false). Default: all.
    * `:preload` - Preload associations. Default: [:node].
  """
  def list_recurring_reminders(user_id, opts \\ []) do
    query =
      case Keyword.get(opts, :enabled) do
        nil ->
          from(r in RecurringReminder, where: r.user_id == ^user_id)

        enabled ->
          from(r in RecurringReminder, where: r.user_id == ^user_id and r.enabled == ^enabled)
      end

    preload = Keyword.get(opts, :preload, [:node])

    query
    |> order_by([r], asc: r.name)
    |> preload(^preload)
    |> Repo.all()
  end

  @doc """
  Get a recurring reminder by ID with node preloaded, scoped to a user.
  """
  def get_recurring_reminder(user_id, id) do
    RecurringReminder
    |> where([r], r.user_id == ^user_id and r.id == ^id)
    |> preload(:node)
    |> Repo.one()
  end

  @doc """
  Create a recurring reminder for a user.

  Expects attrs with :name, :cron, and :node_id.
  Optional: :timezone (default "Europe/Warsaw"), :enabled (default true).
  """
  def create_recurring_reminder(user_id, attrs) do
    result =
      %RecurringReminder{user_id: user_id}
      |> RecurringReminder.changeset(attrs)
      |> Repo.insert()

    case result do
      {:ok, reminder} ->
        Events.broadcast(:recurring_reminder_created, %{
          user_id: user_id,
          source: :memory,
          meta: %{reminder_id: reminder.id, name: reminder.name}
        })

        {:ok, Repo.preload(reminder, :node)}

      error ->
        error
    end
  end

  @doc """
  Update a recurring reminder, scoped to a user.

  If the cron expression changes, all pending Oban jobs for this reminder
  are cancelled so the SchedulerWorker can reschedule with the new pattern.

  The reminder struct must belong to the given user_id (verified by caller).
  """
  def update_recurring_reminder(user_id, %RecurringReminder{} = reminder, attrs) do
    changeset = RecurringReminder.changeset(reminder, attrs)
    cron_changed? = Ecto.Changeset.get_change(changeset, :cron) != nil

    result = Repo.update(changeset)

    case result do
      {:ok, updated} ->
        if cron_changed? do
          cancel_pending_trigger_jobs(updated.id)
        end

        Events.broadcast(:recurring_reminder_updated, %{
          user_id: user_id,
          source: :memory,
          meta: %{reminder_id: updated.id, name: updated.name, cron_changed: cron_changed?}
        })

        {:ok, Repo.preload(updated, :node, force: true)}

      error ->
        error
    end
  end

  @doc """
  Delete a recurring reminder, scoped to a user.

  Accepts either a RecurringReminder struct or an ID string.
  Cancels all pending Oban jobs for this reminder before deletion.
  """
  def delete_recurring_reminder(user_id, %RecurringReminder{} = reminder) do
    cancel_pending_trigger_jobs(reminder.id)

    case Repo.delete(reminder) do
      {:ok, deleted} ->
        Events.broadcast(:recurring_reminder_deleted, %{
          user_id: user_id,
          source: :memory,
          meta: %{reminder_id: deleted.id, name: deleted.name}
        })

        {:ok, deleted}

      error ->
        error
    end
  end

  def delete_recurring_reminder(user_id, id) when is_binary(id) do
    case get_recurring_reminder(user_id, id) do
      nil -> {:error, :not_found}
      reminder -> delete_recurring_reminder(user_id, reminder)
    end
  end

  # Cancels all pending TriggerWorker jobs for a specific recurring reminder.
  defp cancel_pending_trigger_jobs(reminder_id) do
    import Ecto.Query

    # Find all scheduled/available TriggerWorker jobs for this reminder
    job_ids =
      from(j in Oban.Job,
        where: j.worker == "Manfrod.Workers.TriggerWorker",
        where: j.state in ["scheduled", "available"],
        where: fragment("?->>'recurring_reminder_id' = ?", j.args, ^reminder_id),
        select: j.id
      )
      |> Repo.all()

    # Cancel each job
    Enum.each(job_ids, &Oban.cancel_job/1)

    length(job_ids)
  end

  # --- Context Building ---

  @doc """
  Build memory context string for injection into prompts.

  Formats nodes with their UUIDs for reference. The LLM can use
  `recall_memory` to search for more memories or `get_memory` to
  fetch a specific node by ID.
  """
  def escalate_note_access(node_id, new_access_level, readable_levels) do
    case validate_escalation_context(new_access_level, readable_levels) do
      :ok ->
        do_escalate_note_access(node_id, new_access_level, readable_levels)

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp do_escalate_note_access(node_id, new_access_level, readable_levels) do
    case Repo.one(
           from n in Node,
             where: n.id == ^node_id and fragment("? && ?", n.access, ^readable_levels)
         ) do
      nil ->
        {:error, :not_found}

      node ->
        current = node.access

        case validate_escalation_target(current, new_access_level) do
          :ok ->
            merged = Enum.uniq(current ++ [new_access_level])

            node
            |> Node.changeset(%{access: merged})
            |> Repo.update()
            |> case do
              {:ok, updated} ->
                Events.broadcast(:memory_node_escalated, %{
                  node_id: node_id,
                  from_access: current,
                  to_access: merged,
                  source: :escalation
                })

                {:ok, updated}

              err ->
                err
            end

          {:error, reason} ->
            {:error, reason}
        end
    end
  end

  defp validate_escalation_context(new_access_level, readable_levels) do
    cond do
      not String.starts_with?(new_access_level, "external/") ->
        {:error, :invalid_escalation_level}

      "internal" not in readable_levels ->
        {:error, :external_channel_escalation_not_allowed}

      true ->
        :ok
    end
  end

  defp validate_escalation_target(current_access, new_access_level) do
    current_external = Enum.filter(current_access, &String.starts_with?(&1, "external/"))

    cond do
      new_access_level in current_access ->
        {:error, :already_accessible}

      "internal" not in current_access ->
        {:error, :downward_or_cross_scope_escalation}

      new_access_level == "external/all" and current_external != [] ->
        {:error, :external_all_escalation_not_allowed}

      Enum.any?(current_external, &(&1 != new_access_level)) ->
        {:error, :cross_client_escalation_not_allowed}

      true ->
        :ok
    end
  end

  def build_context([]), do: ""

  def build_context(nodes) do
    items =
      nodes
      |> Enum.map(fn node -> "- [#{node.id}] #{node.content}" end)
      |> Enum.join("\n")

    """
    Relevant memories (use recall_memory to search for more, get_memory to fetch by ID):
    #{items}
    """
    |> String.trim()
  end
end
