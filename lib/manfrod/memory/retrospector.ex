defmodule Manfrod.Memory.Retrospector do
  @moduledoc """
  Autonomous agent that builds the zettelkasten.

  Given unprocessed nodes (the slipbox) and tools to manipulate the graph,
  the agent decides how to integrate new knowledge. Structure emerges from
  the agent's decisions, not from prescribed rules.

  ## Tools available to the agent

  - `search` - semantic + keyword search over the graph
  - `get_node` - fetch a node by ID
  - `create_node` - create a new node (returns ID)
  - `update_node` - update a node's content (re-embeds, preserves links)
  - `create_link` - link two nodes by ID (with optional context)
  - `delete_node` - delete a node and its links (for deduplication)
  - `delete_link` - delete a link between nodes
  - `list_links` - list all nodes linked to a given node (for graph exploration)
  - `mark_processed` - mark a node as integrated into the graph
  - `graph_stats` - get graph health statistics (orphans, link ratio, etc.)
  """

  require Logger

  alias Manfrod.{Events, LLM, Memory, Voyage}

  # Embed zettelkasten guide at compile time
  @external_resource Path.join(__DIR__, "zettelkasten.md")
  @zettelkasten_guide File.read!(Path.join(__DIR__, "zettelkasten.md"))

  @system_prompt """
  You are iteratively building a zettelkasten - a personal knowledge graph for
  yourself, composed of atomic notes.

  You have access to:
  - Unprocessed notes from recent conversations (the slipbox)
  - The existing knowledge graph (via search and list_links)
  - Tools to create nodes, create links, delete nodes, delete links, and mark notes as processed
  - A graph_stats tool to check overall graph health
  - A web_search tool to look up current facts on the web when you need to verify or enrich notes

  ## First Step

  Always call graph_stats first. This tells you the current state of the graph:
  how many orphans need connecting, how many weakly connected nodes need
  strengthening, and whether the link-to-note ratio is healthy (aim for > 3.0).

  ## Deduplication

  There is a high chance you'll find duplicates in slipbox, both duplicates of
  other slipbox items and duplicates of what's already in the graph. That's
  because we extract all interesting facts from conversations without regard to
  current contents. Your job is to keep it deduplicated.

  When consolidating duplicates, prefer update_node over delete+create:
  1. Pick the node with more links (it's better connected)
  2. Use update_node to merge the best content from both into that node
  3. Delete the other node

  This preserves the surviving node's ID, links, and provenance.

  ## Link Context

  When creating links, always provide a context explaining why the connection
  exists. Ask yourself: "What should someone expect when following this link?"
  Good: "Both address concurrent programming but from different angles"
  Bad: no context, or "related" (too vague)

  ## Graph Gardening

  Don't just process the slipbox - tend to the garden. Each session, go deeper:
  - Follow links from nodes you touch to see what's connected
  - Look for clusters that could use structure notes
  - Find orphans that deserve connections - these are your top priority
  - Strengthen weakly connected nodes (1 link) with additional connections
  - Notice patterns emerging and create new linking opportunities
  - Consolidate near-duplicates you discover while exploring
  - Let structure emerge from your observations

  The graph is alive. You're not just adding to it - you're shaping it, pruning
  it, helping it grow in interesting directions. Log what you notice. React to
  what you find. Iterate.

  The review nodes you receive are prioritized: orphans first, then weakly
  connected, then oldest nodes, then random. Tackle unprocessed slipbox notes
  first, then work through all the review nodes. For each one, search for
  missed connections, deduplicate, edit, consolidate.

  ## Structure Notes

  When the graph reaches ~700 nodes, start creating structure notes - hub nodes
  that organize and link clusters of related ideas. These are like tables of
  contents for topic areas. Don't force them before the graph is ready.

  When finished, say "Done."

  Here is a guide on zettelkasten best practices:

  #{@zettelkasten_guide}
  """

  # Tool definitions — user_id is baked into closures for search/create
  defp tools(user_id) do
    [
      ReqLLM.Tool.new!(
        name: "search",
        description:
          "Search the knowledge graph for related nodes. Uses semantic similarity and keyword matching.",
        parameter_schema: [
          query: [type: :string, required: true, doc: "Search query text"],
          limit: [type: :integer, doc: "Maximum results to return (default: 5)"]
        ],
        callback: fn args -> tool_search(user_id, args) end
      ),
      ReqLLM.Tool.new!(
        name: "get_node",
        description: "Fetch a specific node by its ID to see its full content.",
        parameter_schema: [
          id: [type: :string, required: true, doc: "Node UUID"]
        ],
        callback: fn args -> tool_get_node(user_id, args) end
      ),
      ReqLLM.Tool.new!(
        name: "create_node",
        description:
          "Create a new node in the knowledge graph. Returns the new node's ID. New nodes are created as already processed (they're derived insights, not raw observations).",
        parameter_schema: [
          content: [
            type: :string,
            required: true,
            doc: "The atomic idea or fact (1-2 sentences)"
          ]
        ],
        callback: fn args -> tool_create_node(user_id, args) end
      ),
      ReqLLM.Tool.new!(
        name: "update_node",
        description:
          "Update a node's content. Use this to consolidate duplicates: merge info into one node and delete the other. Re-embeds automatically. Preserves the node's ID, links, and provenance.",
        parameter_schema: [
          id: [type: :string, required: true, doc: "Node UUID to update"],
          content: [
            type: :string,
            required: true,
            doc: "The new content for the node (1-2 sentences)"
          ]
        ],
        callback: fn args -> tool_update_node(user_id, args) end
      ),
      ReqLLM.Tool.new!(
        name: "create_link",
        description:
          "Create an undirected link between two nodes. Always provide context explaining why the link exists.",
        parameter_schema: [
          node_a_id: [type: :string, required: true, doc: "First node UUID"],
          node_b_id: [type: :string, required: true, doc: "Second node UUID"],
          context: [
            type: :string,
            doc: "Why this link exists - what should someone expect when following it?"
          ]
        ],
        callback: fn args -> tool_create_link(user_id, args) end
      ),
      ReqLLM.Tool.new!(
        name: "mark_processed",
        description:
          "Mark a slipbox node as processed (integrated into the graph). Call this when you're done working with a node.",
        parameter_schema: [
          id: [type: :string, required: true, doc: "Node UUID to mark as processed"]
        ],
        callback: fn args -> tool_mark_processed(user_id, args) end
      ),
      ReqLLM.Tool.new!(
        name: "delete_node",
        description:
          "Delete a node from the knowledge graph. Use this to remove duplicates. All links to/from this node are automatically deleted.",
        parameter_schema: [
          id: [type: :string, required: true, doc: "Node UUID to delete"]
        ],
        callback: fn args -> tool_delete_node(user_id, args) end
      ),
      ReqLLM.Tool.new!(
        name: "delete_link",
        description: "Delete a link between two nodes.",
        parameter_schema: [
          node_a_id: [type: :string, required: true, doc: "First node UUID"],
          node_b_id: [type: :string, required: true, doc: "Second node UUID"]
        ],
        callback: fn args -> tool_delete_link(user_id, args) end
      ),
      ReqLLM.Tool.new!(
        name: "list_links",
        description:
          "List all nodes directly linked to a given node. Use this to explore the graph structure and follow connections.",
        parameter_schema: [
          id: [type: :string, required: true, doc: "Node UUID to get links for"]
        ],
        callback: fn args -> tool_list_links(user_id, args) end
      ),
      ReqLLM.Tool.new!(
        name: "graph_stats",
        description:
          "Get graph health statistics: total nodes, total links, slipbox count, orphan count (0 links), weakly connected count (1 link), and link-to-note ratio. Call this at the start of each session to understand graph health and prioritize work.",
        parameter_schema: [],
        callback: fn args -> tool_graph_stats(user_id, args) end
      ),
      ReqLLM.Tool.new!(
        name: "web_search",
        description:
          "Search the web for current factual information. Use this to verify or enrich notes when you need up-to-date data, confirm facts, or find additional context for graph nodes.",
        parameter_schema: [
          query: [
            type: :string,
            required: true,
            doc: "Search query - what to look up on the web"
          ]
        ],
        callback: &tool_web_search/1
      )
    ]
  end

  # Tool callbacks

  def tool_search(user_id, %{query: query} = args) do
    limit = Map.get(args, :limit, 5)
    {:ok, nodes} = Memory.search(user_id, query, limit: limit)

    if Enum.empty?(nodes) do
      {:ok, "No matching nodes found."}
    else
      result =
        nodes
        |> Enum.map(fn n -> "- [#{n.id}] #{n.content}" end)
        |> Enum.join("\n")

      {:ok, "Found #{length(nodes)} nodes:\n#{result}"}
    end
  end

  def tool_get_node(user_id, %{id: id}) do
    case Memory.get_node(user_id, id) do
      nil ->
        {:ok, "Node not found: #{id}"}

      node ->
        processed = if node.processed_at, do: "yes", else: "no (in slipbox)"
        {:ok, "Node #{id}:\nContent: #{node.content}\nProcessed: #{processed}"}
    end
  end

  def tool_create_node(user_id, %{content: content}) do
    case Voyage.embed_query(content) do
      {:ok, embedding} ->
        now = DateTime.utc_now() |> DateTime.truncate(:second)

        case Memory.create_node(user_id, %{
               content: content,
               embedding: embedding,
               processed_at: now
             }) do
          {:ok, node} ->
            {:ok, "Created node: #{node.id}"}

          {:error, changeset} ->
            {:ok, "Failed to create node: #{inspect(changeset.errors)}"}
        end

      {:error, reason} ->
        {:ok, "Failed to generate embedding: #{inspect(reason)}"}
    end
  end

  def tool_update_node(user_id, %{id: id, content: content}) do
    case Voyage.embed_query(content) do
      {:ok, embedding} ->
        case Memory.update_node(user_id, id, %{content: content, embedding: embedding}) do
          {:ok, _node} ->
            {:ok, "Updated node: #{id}"}

          {:error, :not_found} ->
            {:ok, "Node not found: #{id}"}

          {:error, changeset} ->
            {:ok, "Failed to update node: #{inspect(changeset.errors)}"}
        end

      {:error, reason} ->
        {:ok, "Failed to generate embedding: #{inspect(reason)}"}
    end
  end

  def tool_create_link(user_id, %{node_a_id: a, node_b_id: b} = args) do
    opts = if args[:context], do: [context: args[:context]], else: []

    case Memory.create_link(user_id, a, b, opts) do
      {:ok, _link} ->
        {:ok, "Linked #{a} <-> #{b}"}

      {:error, changeset} ->
        {:ok, "Failed to create link: #{inspect(changeset.errors)}"}
    end
  end

  def tool_mark_processed(user_id, %{id: id}) do
    Memory.mark_processed(user_id, id)
    {:ok, "Marked #{id} as processed"}
  end

  def tool_delete_node(user_id, %{id: id}) do
    case Memory.delete_node(user_id, id) do
      {:ok, _node} ->
        {:ok, "Deleted node: #{id}"}

      {:error, :not_found} ->
        {:ok, "Node not found: #{id}"}
    end
  end

  def tool_delete_link(user_id, %{node_a_id: a, node_b_id: b}) do
    case Memory.delete_link(user_id, a, b) do
      {:ok, _link} ->
        {:ok, "Deleted link: #{a} <-> #{b}"}

      {:error, :not_found} ->
        {:ok, "Link not found: #{a} <-> #{b}"}
    end
  end

  def tool_list_links(user_id, %{id: id}) do
    linked = Memory.get_node_links_with_context(user_id, id)

    if linked == [] do
      {:ok, "Node #{id} has no links (orphan)."}
    else
      result =
        linked
        |> Enum.map(fn {n, context} ->
          line = "- [#{n.id}] #{n.content}"
          if context, do: "#{line}\n  Context: #{context}", else: line
        end)
        |> Enum.join("\n")

      {:ok, "Node #{id} is linked to #{length(linked)} nodes:\n#{result}"}
    end
  end

  def tool_graph_stats(user_id, _args) do
    stats = Memory.graph_stats(user_id)

    {:ok,
     """
     Graph Health:
     - Total nodes: #{stats.total_nodes}
     - Total links: #{stats.total_links}
     - Slipbox (unprocessed): #{stats.slipbox_count}
     - Orphans (0 links): #{stats.orphan_count}
     - Weakly connected (1 link): #{stats.weakly_connected_count}
     - Link-to-note ratio: #{stats.link_to_note_ratio}\
     """}
  end

  def tool_web_search(%{query: query}) do
    case Manfrod.BraveSearch.search(query) do
      {:ok, results} ->
        {:ok, results}

      {:error, :api_key_not_configured} ->
        {:ok, "Web search is not configured (missing API key)."}

      {:error, :rate_limited} ->
        {:ok, "Web search rate limited. Try again in a moment."}

      {:error, reason} ->
        {:ok, "Web search failed: #{inspect(reason)}"}
    end
  end

  # Public API

  @doc """
  Run the retrospection agent.

  Processes the slipbox (unprocessed nodes) and reviews existing graph nodes
  using a priority cascade: orphans first, then weakly connected, then stalest,
  then random — filling up to the review budget.

  Returns :ok or {:error, reason}.
  """
  def process_slipbox(user_id, opts \\ []) do
    batch_size = Keyword.get(opts, :batch_size, 20)
    review_budget = Keyword.get(opts, :review_budget, 25)

    slipbox = Memory.get_slipbox_nodes(user_id, limit: batch_size)
    review_sample = build_review_sample(user_id, review_budget)

    if slipbox == [] and review_sample == [] do
      Logger.debug("Retrospector: nothing to process for user #{user_id} (empty graph)")
      :ok
    else
      Logger.info(
        "Retrospector: processing #{length(slipbox)} slipbox nodes, reviewing #{length(review_sample)} graph nodes for user #{user_id}"
      )

      run_agent(user_id, slipbox, review_sample)
    end
  end

  # Build a review sample using priority cascade:
  # orphans → weakly connected → stalest → random
  # Each tier fills remaining budget, deduplicating by node ID.
  defp build_review_sample(user_id, budget) do
    orphans = Memory.get_orphan_nodes(user_id, limit: budget)
    seen = MapSet.new(orphans, & &1.id)
    remaining = budget - length(orphans)

    {weak, seen, remaining} =
      if remaining > 0 do
        nodes = Memory.get_weakly_connected_nodes(user_id, limit: remaining + MapSet.size(seen))
        new = Enum.reject(nodes, fn n -> MapSet.member?(seen, n.id) end) |> Enum.take(remaining)
        {new, MapSet.union(seen, MapSet.new(new, & &1.id)), remaining - length(new)}
      else
        {[], seen, 0}
      end

    {stale, seen, remaining} =
      if remaining > 0 do
        nodes = Memory.get_stalest_nodes(user_id, limit: remaining + MapSet.size(seen))
        new = Enum.reject(nodes, fn n -> MapSet.member?(seen, n.id) end) |> Enum.take(remaining)
        {new, MapSet.union(seen, MapSet.new(new, & &1.id)), remaining - length(new)}
      else
        {[], seen, 0}
      end

    random =
      if remaining > 0 do
        nodes = Memory.get_random_nodes(user_id, remaining + MapSet.size(seen))
        Enum.reject(nodes, fn n -> MapSet.member?(seen, n.id) end) |> Enum.take(remaining)
      else
        []
      end

    orphans ++ weak ++ stale ++ random
  end

  # Private

  defp run_agent(user_id, slipbox, review_sample) do
    slipbox_text = format_nodes(slipbox)
    review_text = format_nodes(review_sample)

    Events.broadcast(:retrospection_started, %{
      user_id: user_id,
      source: :retrospector,
      meta: %{slipbox_count: length(slipbox), review_count: length(review_sample)}
    })

    user_message = build_user_message(slipbox_text, review_text)

    messages = [
      ReqLLM.Context.system(@system_prompt),
      ReqLLM.Context.user(user_message)
    ]

    case call_with_tools(user_id, messages, 0, %{
           nodes_processed: 0,
           nodes_updated: 0,
           links_created: 0,
           insights_created: 0,
           nodes_deleted: 0,
           links_deleted: 0
         }) do
      {:ok, _final_text, stats} ->
        Logger.info("Retrospector: agent completed successfully for user #{user_id}")

        Events.broadcast(:retrospection_completed, %{
          user_id: user_id,
          source: :retrospector,
          meta: stats
        })

        :ok

      {:error, reason} = err ->
        Logger.error("Retrospector: agent failed for user #{user_id}: #{inspect(reason)}")

        Events.broadcast(:retrospection_failed, %{
          user_id: user_id,
          source: :retrospector,
          meta: %{reason: inspect(reason)}
        })

        err
    end
  end

  defp format_nodes(nodes) do
    nodes
    |> Enum.map(fn n -> "- [#{n.id}] #{n.content}" end)
    |> Enum.join("\n")
  end

  defp build_user_message(slipbox_text, review_text) do
    slipbox_section =
      if slipbox_text == "" do
        "Your slipbox is empty - no new notes to process."
      else
        """
        ## Slipbox (unprocessed notes)

        #{slipbox_text}

        Process these: search for connections, deduplicate, link, and mark as processed.
        """
      end

    review_section =
      if review_text == "" do
        ""
      else
        """

        ## Graph Review (prioritized: orphans → weak → stale → random)

        These nodes need attention. Orphans and weakly connected nodes appear first.
        Use list_links to explore their connections. Look for opportunities to improve
        structure, find missing links, or consolidate related ideas:

        #{review_text}
        """
      end

    slipbox_section <> review_section
  end

  defp call_with_tools(user_id, messages, iteration, stats) do
    if iteration > 150 do
      {:error, :max_iterations}
    else
      ctx = %{user_id: user_id, source: :retrospector}

      case LLM.generate_text(messages, tools: tools(user_id), purpose: :retrospector) do
        {:ok, response} ->
          case ReqLLM.Response.finish_reason(response) do
            :tool_calls ->
              tool_calls = ReqLLM.Response.tool_calls(response)
              narrative = ReqLLM.Response.text(response) || ""

              Logger.debug(
                "Retrospector: executing #{length(tool_calls)} tool(s), iteration #{iteration}"
              )

              # Broadcast narrative text if present
              if narrative != "" do
                Events.broadcast(
                  :narrating,
                  Map.put(ctx, :meta, %{text: narrative, iteration: iteration})
                )
              end

              # Add assistant message with tool calls
              assistant_msg = ReqLLM.Context.assistant(narrative, tool_calls: tool_calls)
              messages_with_assistant = messages ++ [assistant_msg]

              # Execute tools, add results, and update stats
              {messages_with_results, new_stats} =
                Enum.reduce(tool_calls, {messages_with_assistant, stats}, fn tool_call,
                                                                             {msgs, acc_stats} ->
                  action_id = generate_action_id()
                  action_name = tool_call.function.name
                  args = tool_call.function.arguments

                  # Broadcast action started
                  Events.broadcast(
                    :action_started,
                    Map.put(ctx, :meta, %{
                      action_id: action_id,
                      action: action_name,
                      args: args,
                      iteration: iteration
                    })
                  )

                  # Execute and time the action
                  {result, duration_ms, success} = timed_execute_tool(user_id, tool_call)

                  # Broadcast action completed
                  Events.broadcast(
                    :action_completed,
                    Map.put(ctx, :meta, %{
                      action_id: action_id,
                      action: action_name,
                      result: truncate_result(result),
                      duration_ms: duration_ms,
                      success: success,
                      iteration: iteration
                    })
                  )

                  tool_result_msg =
                    ReqLLM.Context.tool_result(tool_call.id, action_name, result)

                  updated_stats = update_stats(acc_stats, action_name)
                  {msgs ++ [tool_result_msg], updated_stats}
                end)

              # Continue
              call_with_tools(user_id, messages_with_results, iteration + 1, new_stats)

            _other ->
              text = ReqLLM.Response.text(response) || ""
              Logger.debug("Retrospector: agent finished with: #{String.slice(text, 0, 100)}")

              # Broadcast final narrative
              if text != "" do
                Events.broadcast(
                  :narrating,
                  Map.put(ctx, :meta, %{text: text, iteration: iteration, final: true})
                )
              end

              {:ok, text, stats}
          end

        {:error, _} = err ->
          err
      end
    end
  end

  defp update_stats(stats, "mark_processed"), do: Map.update!(stats, :nodes_processed, &(&1 + 1))
  defp update_stats(stats, "update_node"), do: Map.update!(stats, :nodes_updated, &(&1 + 1))
  defp update_stats(stats, "create_link"), do: Map.update!(stats, :links_created, &(&1 + 1))
  defp update_stats(stats, "create_node"), do: Map.update!(stats, :insights_created, &(&1 + 1))
  defp update_stats(stats, "delete_node"), do: Map.update!(stats, :nodes_deleted, &(&1 + 1))
  defp update_stats(stats, "delete_link"), do: Map.update!(stats, :links_deleted, &(&1 + 1))
  defp update_stats(stats, _tool), do: stats

  defp timed_execute_tool(user_id, tool_call) do
    start_time = System.monotonic_time(:millisecond)
    {result, success} = execute_tool(user_id, tool_call)
    end_time = System.monotonic_time(:millisecond)
    duration_ms = end_time - start_time

    {result, duration_ms, success}
  end

  defp execute_tool(user_id, tool_call) do
    tool_name = tool_call.function.name
    args_json = tool_call.function.arguments

    case Jason.decode(args_json) do
      {:ok, args} ->
        tool = Enum.find(tools(user_id), &(&1.name == tool_name))

        if tool do
          case ReqLLM.Tool.execute(tool, args) do
            {:ok, result} -> {result, true}
            {:error, reason} -> {"Tool error: #{inspect(reason)}", false}
          end
        else
          {"Unknown tool: #{tool_name}", false}
        end

      {:error, _} ->
        {"Failed to parse tool arguments", false}
    end
  end

  defp generate_action_id do
    Base.encode16(:crypto.strong_rand_bytes(4), case: :lower)
  end

  defp truncate_result(result) when byte_size(result) > 500 do
    String.slice(result, 0, 497) <> "..."
  end

  defp truncate_result(result), do: result
end
