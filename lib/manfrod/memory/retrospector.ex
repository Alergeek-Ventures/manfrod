defmodule Manfrod.Memory.Retrospector do
  @moduledoc """
  Autonomous agent that builds and maintains the zettelkasten. The whole
  retrospection system lives here: the mechanical exact-duplicate merge, the
  agent's system prompt (with the zettelkasten guide embedded from
  `zettelkasten.md`), its graph tools, and the orchestration around them.

  Runs on two schedules:

  - Every 2 hours, via `Manfrod.Workers.RetrospectionWorker` (`process_all_buckets/1`):
    merges exact 1:1 duplicates mechanically (`merge_exact_duplicates/0` — no
    LLM; verbatim copies are bookkeeping, not judgment), then per access
    bucket drains the slipbox in batches — each batch is an agent run over
    the unprocessed nodes plus a prioritized review sample (orphans →
    weakly connected → stalest → random).
  - Daily, via `Manfrod.Workers.GraphReviewWorker` (`review_processed_graph/1`):
    a slipbox-independent deep review. The 2-hourly run only reviews existing
    nodes as a side effect of a bucket having new slipbox content, so a fully
    processed bucket never gets revisited otherwise and near-duplicates/orphans
    accumulate. This runs the same agent over a review sample of every
    processed bucket regardless of slipbox state.

  Every listed node (slipbox or review sample) is annotated with its nearest
  embedding neighbors so the agent sees duplicate suspects and link candidates
  without guessing search queries.

  Given unprocessed nodes (the slipbox) and tools to manipulate the graph,
  the agent decides how to integrate new knowledge. Structure emerges from
  the agent's decisions, not from prescribed rules.

  ## Tools available to the agent

  - `search` - semantic + keyword search over the graph, optionally scoped to one project
  - `list_projects` - list known projects (name + slug)
  - `get_node` - fetch a node by ID
  - `find_similar` - nearest nodes by embedding (duplicate/link candidates)
  - `create_node` - create a new node, optionally tagged with a project (returns ID)
  - `update_node` - update a node's content and/or project (re-embeds, preserves links)
  - `create_link` - link two nodes by ID (with optional context)
  - `delete_node` - delete a node and its links (for deduplication)
  - `delete_link` - delete a link between nodes
  - `list_links` - list all nodes linked to a given node
  - `mark_processed` - mark a node as integrated into the graph
  - `graph_stats` - graph health statistics (orphans, link ratio, etc.)
  - `web_search` - Brave web search for fact verification/enrichment
  """

  import Ecto.Query

  require Logger

  alias Manfrod.{Events, LLM, Memory, Repo, Voyage}
  alias Manfrod.Accounts.User
  alias Manfrod.Memory.{Link, Node}
  alias Manfrod.Tools.WebSearch

  # Embed zettelkasten guide at compile time
  @external_resource Path.join(__DIR__, "zettelkasten.md")
  @zettelkasten_guide File.read!(Path.join(__DIR__, "zettelkasten.md"))

  @system_prompt """
  You are iteratively building a zettelkasten - a personal knowledge graph for
  yourself, composed of atomic notes.

  You have access to:
  - Unprocessed notes from recent conversations (the slipbox)
  - The existing knowledge graph (via search, find_similar, and list_links)
  - Tools to create nodes, create links, delete nodes, delete links, and mark notes as processed
  - A graph_stats tool to check overall graph health
  - A web_search tool to look up current facts on the web when you need to verify or enrich notes

  Every node listed in your input comes annotated with its nearest existing
  nodes by embedding similarity (lines starting with "~", with a `sim` score).
  These annotations are precomputed for you — they are your duplicate suspects
  and link candidates. Use them; don't rediscover them with blind searches.

  ## First Step

  Always call graph_stats first. This tells you the current state of the graph:
  how many orphans need connecting, how many weakly connected nodes need
  strengthening, and whether the link-to-note ratio is healthy (aim for > 3.0).

  ## Deduplication

  Exact 1:1 text duplicates are merged mechanically before you run — what
  reaches you are the judgment calls: near-duplicates and rewordings. Expect
  many of them, both between slipbox items and against the existing graph.
  That's because we extract all interesting facts from conversations without
  regard to current contents. Your job is to keep the graph deduplicated.

  The rule: **same fact, different wording → merge. Different facts about the
  same topic → link, don't merge.**

  - A "~" neighbor marked LIKELY DUPLICATE (sim ≥ 0.85): merge it unless the
    two clearly state different facts.
  - A "~" neighbor with sim 0.7–0.85: read both carefully — reworded
    duplicates often score in this range. Use find_similar or get_node when
    the one-line preview isn't enough to decide.
  - Two slipbox items can duplicate each other too — resolve those before
    integrating either.

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
  - Find orphans that deserve connections - these are your top priority. An
    orphan's "~" neighbors are ready-made link candidates: if one genuinely
    relates, create the link (with context) rather than leaving the orphan
    unconnected. Only leave an orphan alone when none of its neighbors truly
    relate — never because you didn't check.
  - Strengthen weakly connected nodes (1 link) with additional connections
  - Notice patterns emerging and create new linking opportunities
  - Consolidate near-duplicates you discover while exploring (find_similar on
    any node you touch is a cheap check)
  - Let structure emerge from your observations

  The graph is alive. You're not just adding to it - you're shaping it, pruning
  it, helping it grow in interesting directions. Log what you notice. React to
  what you find. Iterate.

  The review nodes you receive are prioritized: orphans first, then weakly
  connected, then oldest nodes, then random. Tackle unprocessed slipbox notes
  first, then work through all the review nodes. For each one, search for
  missed connections, deduplicate, edit, consolidate.

  ## Project Grouping

  Some nodes carry a project tag, shown as `[project: Name]` right after the
  node's id in every listing and neighbor line — stamped automatically from
  the Slack channel a note came from, when that channel is mapped to a
  project. Not every node has one; an untagged node is a normal, expected
  state, not something to fix by guessing.

  Treat a shared project tag as a strong, deterministic clustering signal,
  on top of (not instead of) embedding similarity:

  - Two project-tagged nodes sharing the same project are natural link
    candidates even at moderate "~" similarity — shared project context
    often means shared relevance that the embedding alone underweights.
  - When working through project-tagged slipbox or review nodes, use
    `search`'s `project` parameter to pull the rest of that project's nodes
    and check for missed connections within it, the same way you'd search
    keywords for a topic.
  - If a project's own cluster grows dense enough that you're losing
    overview of it (the same "losing overview" trigger as Structure Notes
    below, just scoped to one project instead of the whole graph), create a
    structure note for it and tag it with that project via `create_node`'s
    `project` parameter — this lets a project's own hub emerge naturally
    from its nodes, the same way a general hub emerges from a topic cluster.
  - If you find a node whose project tag looks wrong, or an obviously
    project-specific node with no tag at all, correct it with `update_node`'s
    `project` parameter — don't leave a wrong or missing tag once you've
    noticed it while working the graph.
  - Use `list_projects` if you're unsure of a project's exact name/slug.

  ## Structure Notes

  When the graph reaches ~700 nodes, start creating structure notes - hub nodes
  that organize and link clusters of related ideas. These are like tables of
  contents for topic areas. Don't force them before the graph is ready.

  When finished, say "Done."

  Here is a guide on zettelkasten best practices:

  #{@zettelkasten_guide}
  """

  # ---------------------------------------------------------------------------
  # Public API
  # ---------------------------------------------------------------------------

  @doc """
  Process all pending slipbox nodes, grouped by access bucket.
  Each bucket gets its own agent run with appropriate readable_levels and
  write_access. This is the entry point for `Manfrod.Workers.RetrospectionWorker`.
  """
  def process_all_buckets(opts \\ []) do
    # Verbatim duplicates are bookkeeping, not judgment — merge them
    # mechanically first so the agent's budget goes to near-duplicates,
    # linking, and orphans.
    merge_exact_duplicates()

    buckets = Memory.list_slipbox_access_buckets()

    if buckets == [] do
      Logger.debug("Retrospector: no pending nodes in any access bucket")
      :ok
    else
      Logger.info("Retrospector: processing #{length(buckets)} access bucket(s)")

      Enum.each(buckets, fn access_bucket ->
        readable_levels = Enum.uniq(["internal" | access_bucket])
        write_access = access_bucket
        user_id = find_bucket_user_id(access_bucket)

        if user_id do
          process_bucket(user_id, readable_levels, write_access, opts)
        else
          Logger.warning(
            "Retrospector: no user found for bucket #{inspect(access_bucket)}, skipping"
          )
        end
      end)

      :ok
    end
  end

  @doc """
  Merge all groups of exact-duplicate nodes (same whitespace-trimmed content,
  same access bucket) across the whole graph — mechanically, no LLM. The
  extractor writes facts without checking what's already stored, so verbatim
  duplicates accumulate; this keeps the agent's LLM budget for judgment
  calls only.

  Keeps the best copy of each group (most links → processed over slipbox →
  oldest), repoints the others' links onto it, and deletes them.

  Returns `%{groups: n, deleted: n}`.
  """
  def merge_exact_duplicates do
    groups = duplicate_groups()

    result =
      Enum.reduce(groups, %{groups: 0, deleted: 0}, fn {content, access}, acc ->
        case merge_group(content, access) do
          {:ok, deleted_count} ->
            %{acc | groups: acc.groups + 1, deleted: acc.deleted + deleted_count}

          :noop ->
            acc
        end
      end)

    if result.groups > 0 do
      Logger.info(
        "Retrospector: merged #{result.groups} exact-duplicate group(s), " <>
          "deleted #{result.deleted} node(s)"
      )
    end

    result
  end

  @doc """
  Deep review of the already-integrated graph, independent of slipbox
  state. The 2-hourly slipbox drain only reviews existing nodes opportunistically
  (as context for buckets that happen to have new slipbox content) — a bucket
  that's fully processed never gets revisited otherwise, so old near-duplicates
  and orphans accumulate. This closes that gap: it runs the same agent, with
  the same tools, over a prioritized sample (orphans → weak → stale → random)
  of every processed bucket, whether or not there's anything new to process.

  Runs daily via `Manfrod.Workers.GraphReviewWorker`.

  ## Options

    * `:review_budget` - max nodes sampled per bucket (default 100)
  """
  def review_processed_graph(opts \\ []) do
    merge_exact_duplicates()

    budget = Keyword.get(opts, :review_budget, 100)
    buckets = Memory.list_processed_access_buckets()

    if buckets == [] do
      Logger.debug("Retrospector: no processed nodes in any access bucket")
      :ok
    else
      Logger.info("Retrospector: deep-reviewing #{length(buckets)} access bucket(s)")

      Enum.each(buckets, fn access_bucket ->
        readable_levels = Enum.uniq(["internal" | access_bucket])
        user_id = find_bucket_user_id(access_bucket)
        review_sample = user_id && build_review_sample(access_bucket, budget)

        cond do
          is_nil(user_id) ->
            Logger.warning(
              "Retrospector: no user found for bucket #{inspect(access_bucket)}, skipping"
            )

          review_sample == [] ->
            :ok

          true ->
            run_agent(user_id, readable_levels, access_bucket, [], review_sample, :graph_review)
        end
      end)

      :ok
    end
  end

  # ---------------------------------------------------------------------------
  # Mechanical exact-duplicate merge
  # ---------------------------------------------------------------------------

  defp duplicate_groups do
    from(n in Node,
      group_by: [fragment("btrim(?)", n.content), n.access],
      having: count(n.id) > 1,
      select: {fragment("btrim(?)", n.content), n.access}
    )
    |> Repo.all()
  end

  defp merge_group(content, access) do
    nodes =
      from(n in Node,
        where: fragment("btrim(?)", n.content) == ^content and n.access == ^access
      )
      |> Repo.all()

    if length(nodes) < 2 do
      :noop
    else
      link_counts = link_counts(Enum.map(nodes, & &1.id))

      [survivor | losers] =
        Enum.sort_by(nodes, fn n ->
          {-Map.get(link_counts, n.id, 0), if(n.processed_at, do: 0, else: 1), n.inserted_at}
        end)

      group_ids = MapSet.new(nodes, & &1.id)
      Enum.each(losers, &absorb(survivor, &1, group_ids))
      {:ok, length(losers)}
    end
  end

  defp link_counts(node_ids) do
    from(l in Link,
      where: l.node_a_id in ^node_ids or l.node_b_id in ^node_ids,
      select: {l.node_a_id, l.node_b_id}
    )
    |> Repo.all()
    |> Enum.flat_map(fn {a, b} -> [a, b] end)
    |> Enum.filter(&(&1 in node_ids))
    |> Enum.frequencies()
  end

  # Repoint the loser's links onto the survivor (skipping intra-group links,
  # which would become self-links), then delete the loser and its links.
  defp absorb(survivor, loser, group_ids) do
    links =
      from(l in Link, where: l.node_a_id == ^loser.id or l.node_b_id == ^loser.id)
      |> Repo.all()

    for link <- links do
      other = if link.node_a_id == loser.id, do: link.node_b_id, else: link.node_a_id

      unless MapSet.member?(group_ids, other) do
        %Link{}
        |> Link.changeset(%{node_a_id: survivor.id, node_b_id: other, context: link.context})
        |> Repo.insert(on_conflict: :nothing)
      end
    end

    from(l in Link, where: l.node_a_id == ^loser.id or l.node_b_id == ^loser.id)
    |> Repo.delete_all()

    Repo.delete(loser)

    Events.broadcast(:memory_node_deleted, %{
      user_id: loser.user_id,
      source: :memory,
      meta: %{node_id: loser.id, reason: :exact_duplicate, merged_into: survivor.id}
    })
  end

  # ---------------------------------------------------------------------------
  # Bucket processing
  # ---------------------------------------------------------------------------

  defp find_bucket_user_id(access_bucket) do
    Repo.one(
      from n in Node,
        where: n.access == ^access_bucket,
        order_by: [desc: n.inserted_at],
        select: n.user_id,
        limit: 1
    )
  end

  # Drain the bucket's slipbox in batches instead of processing a single
  # batch per run — if a burst of conversations outpaces one 2-hourly batch of
  # 20, the backlog itself breeds duplicates (the extractor doesn't check
  # the graph, so the same fact re-extracted lands as a new slipbox node).
  # Capped at max_batches; stops early on agent error or when a batch makes
  # no slipbox progress (a lazy run would otherwise be re-fed the same
  # nodes until the cap).
  defp process_bucket(user_id, readable_levels, write_access, opts, batch_no \\ 1) do
    batch_size = Keyword.get(opts, :batch_size, 20)
    review_budget = Keyword.get(opts, :review_budget, 25)
    max_batches = Keyword.get(opts, :max_batches, 5)

    slipbox = Memory.get_slipbox_nodes_by_access(write_access, limit: batch_size)

    cond do
      slipbox == [] ->
        Logger.debug("Retrospector: slipbox empty for bucket #{inspect(write_access)}")

      batch_no > max_batches ->
        Logger.info(
          "Retrospector: batch cap (#{max_batches}) reached for bucket " <>
            "#{inspect(write_access)}, #{length(slipbox)}+ slipbox nodes left for next run"
        )

      true ->
        Logger.info(
          "Retrospector: batch #{batch_no}/#{max_batches} — #{length(slipbox)} slipbox " <>
            "nodes for bucket #{inspect(write_access)}"
        )

        review_sample = build_review_sample(write_access, review_budget)
        batch_ids = Enum.map(slipbox, & &1.id)

        case run_agent(
               user_id,
               readable_levels,
               write_access,
               slipbox,
               review_sample,
               :slipbox_drain
             ) do
          :ok ->
            if unprocessed_count(batch_ids) < length(batch_ids) do
              process_bucket(user_id, readable_levels, write_access, opts, batch_no + 1)
            else
              Logger.warning(
                "Retrospector: batch #{batch_no} made no slipbox progress for bucket " <>
                  "#{inspect(write_access)}, stopping"
              )
            end

          {:error, _} ->
            :ok
        end
    end
  end

  # How many of the given batch nodes are still unprocessed and undeleted
  # (i.e. the agent neither marked them processed nor merged them away).
  defp unprocessed_count(node_ids) do
    Repo.one(
      from n in Node,
        where: n.id in ^node_ids and is_nil(n.processed_at),
        select: count(n.id)
    )
  end

  # Build a review sample using priority cascade:
  # orphans → weakly connected → stalest → random
  # Each tier fills remaining budget, deduplicating by node ID.
  #
  # Scoped by the bucket's access array, not by a single author's user_id —
  # a bucket written to by several people would otherwise only ever surface
  # one arbitrary person's nodes (see find_bucket_user_id/1), leaving the
  # rest invisible to review even though they're shown to the agent
  # elsewhere (slipbox listing, find_similar) via proper access scoping.
  defp build_review_sample(access, budget) do
    orphans = Memory.get_orphan_nodes_by_access(access, limit: budget)
    seen = MapSet.new(orphans, & &1.id)
    remaining = budget - length(orphans)

    {weak, seen, remaining} =
      if remaining > 0 do
        nodes =
          Memory.get_weakly_connected_nodes_by_access(access,
            limit: remaining + MapSet.size(seen)
          )

        new = Enum.reject(nodes, fn n -> MapSet.member?(seen, n.id) end) |> Enum.take(remaining)
        {new, MapSet.union(seen, MapSet.new(new, & &1.id)), remaining - length(new)}
      else
        {[], seen, 0}
      end

    {stale, seen, remaining} =
      if remaining > 0 do
        nodes = Memory.get_stalest_nodes_by_access(access, limit: remaining + MapSet.size(seen))
        new = Enum.reject(nodes, fn n -> MapSet.member?(seen, n.id) end) |> Enum.take(remaining)
        {new, MapSet.union(seen, MapSet.new(new, & &1.id)), remaining - length(new)}
      else
        {[], seen, 0}
      end

    random =
      if remaining > 0 do
        nodes = Memory.get_random_nodes_by_access(access, remaining + MapSet.size(seen))
        Enum.reject(nodes, fn n -> MapSet.member?(seen, n.id) end) |> Enum.take(remaining)
      else
        []
      end

    orphans ++ weak ++ stale ++ random
  end

  # ---------------------------------------------------------------------------
  # Agent run
  # ---------------------------------------------------------------------------

  defp run_agent(user_id, readable_levels, write_access, slipbox, review_sample, kind) do
    slipbox_text = format_nodes(slipbox, readable_levels)
    review_text = format_nodes(review_sample, readable_levels)

    Events.broadcast(:retrospection_started, %{
      user_id: user_id,
      source: :retrospector,
      meta: %{slipbox_count: length(slipbox), review_count: length(review_sample), kind: kind}
    })

    user_message = build_user_message(slipbox_text, review_text)

    messages = [
      ReqLLM.Context.system(@system_prompt),
      ReqLLM.Context.user(user_message)
    ]

    case call_with_tools(user_id, readable_levels, write_access, messages, 0, %{
           nodes_processed: 0,
           nodes_updated: 0,
           links_created: 0,
           insights_created: 0,
           nodes_deleted: 0,
           links_deleted: 0,
           input_tokens_used: 0
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

  # Precomputed embedding neighbors ride along with every listed node so the
  # agent doesn't have to guess search queries to find near-duplicates or
  # link candidates — the main reason past runs left orphans unlinked and
  # near-duplicates unmerged.
  @neighbor_limit 3
  @neighbor_max_distance 0.5
  @likely_duplicate_distance 0.15

  defp format_nodes(nodes, readable_levels) do
    project_names = project_name_map()

    nodes
    |> Enum.map(fn n ->
      base = "- [#{n.id}]#{project_tag(n, project_names)} #{n.content}"

      case Memory.similar_nodes(n, readable_levels,
             limit: @neighbor_limit,
             max_distance: @neighbor_max_distance
           ) do
        [] ->
          base

        neighbors ->
          neighbor_lines =
            Enum.map(neighbors, fn {m, distance} ->
              similarity = Float.round(1.0 - distance, 2)
              flag = if distance < @likely_duplicate_distance, do: " LIKELY DUPLICATE —", else: ""

              "    ~ [#{m.id}]#{project_tag(m, project_names)} (sim #{similarity})#{flag} #{m.content}"
            end)

          Enum.join([base | neighbor_lines], "\n")
      end
    end)
    |> Enum.join("\n")
  end

  defp project_name_map do
    Map.new(Memory.list_projects(), fn p -> {p.id, p.name} end)
  end

  defp project_tag(%{project_id: nil}, _project_names), do: ""

  defp project_tag(%{project_id: project_id}, project_names) do
    case Map.get(project_names, project_id) do
      nil -> ""
      name -> " [project: #{name}]"
    end
  end

  defp build_user_message(slipbox_text, review_text) do
    slipbox_section =
      if slipbox_text == "" do
        "Your slipbox is empty - no new notes to process."
      else
        """
        ## Slipbox (unprocessed notes)

        Lines starting with "~" are the node's nearest existing nodes by
        embedding similarity — your duplicate suspects and link candidates.
        Treat "LIKELY DUPLICATE" as a merge unless the two clearly state
        different facts.

        #{slipbox_text}

        Process these: resolve every duplicate suspect first (merge via
        update_node + delete_node), then link, then mark as processed.
        """
      end

    review_section =
      if review_text == "" do
        ""
      else
        """

        ## Graph Review (prioritized: orphans → weak → stale → random)

        These nodes need attention. Orphans and weakly connected nodes appear first.
        Each comes with its nearest neighbors ("~" lines) — for an orphan those are
        your ready-made link candidates: if one genuinely relates, create the link
        (with context) instead of leaving the orphan unconnected. Use list_links to
        explore further, and merge any duplicate suspects you confirm:

        #{review_text}
        """
      end

    slipbox_section <> review_section
  end

  # Bounds a single agent run's iteration count — the rest of the
  # slipbox/review sample is picked up by the next cron tick or the next
  # batch in process_bucket/5, so no work is lost, just deferred.
  @max_iterations 150

  # Every this many iterations, fold everything except the original
  # system/user framing and the most recent turn into a short progress
  # summary — the single biggest lever on token cost, since without it every
  # iteration resends the full history of every prior tool call and result.
  @compact_every 10

  defp call_with_tools(user_id, readable_levels, write_access, messages, iteration, stats) do
    if iteration > @max_iterations do
      {:error, :max_iterations}
    else
      ctx = %{user_id: user_id, source: :retrospector}

      case LLM.generate_text(messages,
             tools: tools(user_id, readable_levels, write_access),
             purpose: :retrospector
           ) do
        {:ok, response} ->
          usage = ReqLLM.Response.usage(response) || %{}
          call_input_tokens = usage[:input_tokens] || 0
          stats = Map.update!(stats, :input_tokens_used, &(&1 + call_input_tokens))

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
                  {result, duration_ms, success} =
                    timed_execute_tool(user_id, readable_levels, write_access, tool_call)

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

              next_messages =
                maybe_compact(messages, messages_with_results, new_stats, iteration + 1)

              # Continue
              call_with_tools(
                user_id,
                readable_levels,
                write_access,
                next_messages,
                iteration + 1,
                new_stats
              )

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

  # Keeps a run's context bounded: past @compact_every iterations, everything
  # between the original system/user framing and the most recent turn is
  # replaced by a short stats-based progress note. The agent is told to
  # re-check node state via get_node/search rather than trust memory of
  # dropped tool calls — a cheap targeted lookup beats resending the whole
  # history just to avoid one.
  defp maybe_compact(prior_messages, full_messages, stats, iteration) do
    if rem(iteration, @compact_every) == 0 do
      base = Enum.take(full_messages, 2)
      last_turn = Enum.drop(full_messages, length(prior_messages))
      summary = ReqLLM.Context.user(progress_summary(stats, iteration))
      base ++ [summary] ++ last_turn
    else
      full_messages
    end
  end

  defp progress_summary(stats, iteration) do
    """
    ## Progress so far (iteration #{iteration})

    To keep context small, earlier tool calls and their results have been
    compacted out of this conversation. Cumulative progress across the whole
    run: #{stats.nodes_processed} marked processed, #{stats.nodes_updated} updated, \
    #{stats.links_created} links created, #{stats.insights_created} new nodes created, \
    #{stats.nodes_deleted} deleted, #{stats.links_deleted} links deleted.

    Keep working through the slipbox and review nodes listed above that you
    haven't handled yet. If you're unsure whether a specific node was already
    handled, use get_node or search to check its current state rather than
    relying on memory of earlier tool calls.
    """
  end

  defp update_stats(stats, "mark_processed"), do: Map.update!(stats, :nodes_processed, &(&1 + 1))
  defp update_stats(stats, "update_node"), do: Map.update!(stats, :nodes_updated, &(&1 + 1))
  defp update_stats(stats, "create_link"), do: Map.update!(stats, :links_created, &(&1 + 1))
  defp update_stats(stats, "create_node"), do: Map.update!(stats, :insights_created, &(&1 + 1))
  defp update_stats(stats, "delete_node"), do: Map.update!(stats, :nodes_deleted, &(&1 + 1))
  defp update_stats(stats, "delete_link"), do: Map.update!(stats, :links_deleted, &(&1 + 1))
  defp update_stats(stats, _tool), do: stats

  defp timed_execute_tool(user_id, readable_levels, write_access, tool_call) do
    start_time = System.monotonic_time(:millisecond)
    {result, success} = execute_tool(user_id, readable_levels, write_access, tool_call)
    end_time = System.monotonic_time(:millisecond)
    duration_ms = end_time - start_time

    {result, duration_ms, success}
  end

  defp execute_tool(user_id, readable_levels, write_access, tool_call) do
    tool_name = tool_call.function.name
    args_json = tool_call.function.arguments

    case Jason.decode(args_json) do
      {:ok, args} ->
        tool = Enum.find(tools(user_id, readable_levels, write_access), &(&1.name == tool_name))

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

  # ---------------------------------------------------------------------------
  # Tools
  # ---------------------------------------------------------------------------

  # Tool definitions — readable_levels/write_access (the shared access
  # bucket) are baked into closures for lookups/mutations, not the run's
  # representative user_id: a bucket written to by several people has nodes
  # under several different user_ids, and user_id is provenance, not access
  # control (see Memory's moduledoc). Scoping tools by it instead of access
  # made most of a bucket's own nodes invisible to get_node/update_node/
  # mark_processed/etc. — the model would see a real ID in the slipbox
  # listing or a find_similar neighbor (both correctly access-scoped) and
  # then get "not found" trying to act on it.
  defp tools(user_id, readable_levels, write_access) do
    # New nodes are attributed to a dedicated system identity, not the
    # bucket's representative user_id — the latter can shift between runs
    # (see find_bucket_user_id/1), which would orphan a node's provenance.
    create_user_id = system_user_id()

    [
      ReqLLM.Tool.new!(
        name: "search",
        description:
          "Search the knowledge graph for related nodes. Uses semantic similarity and keyword matching. Optionally scope to one project — useful when working through a cluster of project-tagged nodes to find its in-project connections.",
        parameter_schema: [
          query: [type: :string, required: true, doc: "Search query text"],
          limit: [type: :integer, doc: "Maximum results to return (default: 5)"],
          project: [
            type: :string,
            required: false,
            doc: "Project name or slug to scope results to (see list_projects)"
          ]
        ],
        callback: fn args -> tool_search(user_id, readable_levels, args) end
      ),
      ReqLLM.Tool.new!(
        name: "list_projects",
        description:
          "List all known projects (name + slug). Use to confirm a project's exact name before scoping search to it or tagging a node with it.",
        parameter_schema: [],
        callback: fn _args -> tool_list_projects() end
      ),
      ReqLLM.Tool.new!(
        name: "get_node",
        description: "Fetch a specific node by its ID to see its full content.",
        parameter_schema: [
          id: [type: :string, required: true, doc: "Node UUID"]
        ],
        callback: fn args -> tool_get_node(readable_levels, args) end
      ),
      ReqLLM.Tool.new!(
        name: "find_similar",
        description:
          "Find the nodes most semantically similar to a given node (by embedding distance). The primary tool for spotting near-duplicates and link candidates — more precise than text search when you already have a node in hand.",
        parameter_schema: [
          id: [type: :string, required: true, doc: "Node UUID to find similar nodes for"],
          limit: [type: :integer, doc: "Maximum results (default: 5)"]
        ],
        callback: fn args -> tool_find_similar(readable_levels, args) end
      ),
      ReqLLM.Tool.new!(
        name: "create_node",
        description:
          "Create a new node in the knowledge graph. Returns the new node's ID. New nodes are created as already processed (they're derived insights, not raw observations). Tag it with `project` when it's a project-specific insight or structure/hub note for that project.",
        parameter_schema: [
          content: [
            type: :string,
            required: true,
            doc: "The atomic idea or fact (1-2 sentences)"
          ],
          project: [
            type: :string,
            required: false,
            doc:
              "Project name or slug this node belongs to, if project-specific (see list_projects). Omit for general/cross-project nodes."
          ]
        ],
        callback: fn args -> tool_create_node(create_user_id, write_access, args) end
      ),
      ReqLLM.Tool.new!(
        name: "update_node",
        description:
          "Update a node's content. Use this to consolidate duplicates: merge info into one node and delete the other. Re-embeds automatically. Preserves the node's ID, links, and provenance. Can also set/correct which project the node belongs to.",
        parameter_schema: [
          id: [type: :string, required: true, doc: "Node UUID to update"],
          content: [
            type: :string,
            required: true,
            doc: "The new content for the node (1-2 sentences)"
          ],
          project: [
            type: :string,
            required: false,
            doc:
              "Set/correct this node's project (name or slug, see list_projects). Omit to leave its current project attribution unchanged."
          ]
        ],
        callback: fn args -> tool_update_node(readable_levels, args) end
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
        callback: fn args -> tool_mark_processed(readable_levels, args) end
      ),
      ReqLLM.Tool.new!(
        name: "delete_node",
        description:
          "Delete a node from the knowledge graph. Use this to remove duplicates. All links to/from this node are automatically deleted.",
        parameter_schema: [
          id: [type: :string, required: true, doc: "Node UUID to delete"]
        ],
        callback: fn args -> tool_delete_node(readable_levels, args) end
      ),
      ReqLLM.Tool.new!(
        name: "delete_link",
        description: "Delete a link between two nodes.",
        parameter_schema: [
          node_a_id: [type: :string, required: true, doc: "First node UUID"],
          node_b_id: [type: :string, required: true, doc: "Second node UUID"]
        ],
        callback: fn args -> tool_delete_link(readable_levels, args) end
      ),
      ReqLLM.Tool.new!(
        name: "list_links",
        description:
          "List all nodes directly linked to a given node. Use this to explore the graph structure and follow connections.",
        parameter_schema: [
          id: [type: :string, required: true, doc: "Node UUID to get links for"]
        ],
        callback: fn args -> tool_list_links(readable_levels, args) end
      ),
      ReqLLM.Tool.new!(
        name: "graph_stats",
        description:
          "Get graph health statistics: total nodes, total links, slipbox count, orphan count (0 links), weakly connected count (1 link), and link-to-note ratio. Call this at the start of each session to understand graph health and prioritize work.",
        parameter_schema: [],
        callback: fn args -> tool_graph_stats(write_access, args) end
      )
    ] ++ WebSearch.definitions(%{})
  end

  defp system_user_id do
    slack_id = "system:retrospector"

    case Repo.get_by(User, slack_id: slack_id) do
      nil ->
        {:ok, user} =
          %User{}
          |> User.changeset(%{
            slack_id: slack_id,
            slack_dm_channel_id: slack_id,
            name: "Retrospector",
            email: "retrospector@system.manfrod"
          })
          |> Repo.insert()

        user.id

      user ->
        user.id
    end
  end

  # Tool callbacks

  defp tool_search(user_id, readable_levels, %{query: query} = args) do
    limit = Map.get(args, :limit, 5)
    project_name = Map.get(args, :project)

    case resolve_project_id(project_name) do
      {:ok, project_id} ->
        {:ok, nodes} =
          Memory.search(user_id, readable_levels, query, limit: limit, project_id: project_id)

        if Enum.empty?(nodes) do
          {:ok, "No matching nodes found."}
        else
          result =
            nodes
            |> Enum.map(fn n -> "- [#{n.id}] #{n.content}" end)
            |> Enum.join("\n")

          {:ok, "Found #{length(nodes)} nodes:\n#{result}"}
        end

      {:error, :unknown_project} ->
        {:ok, unknown_project_message(project_name)}
    end
  end

  defp tool_list_projects do
    case Memory.list_projects() do
      [] ->
        {:ok, "No projects configured."}

      projects ->
        lines = Enum.map(projects, fn p -> "- #{p.name} (slug: #{p.slug})" end)
        {:ok, "Projects:\n#{Enum.join(lines, "\n")}"}
    end
  end

  # nil (project not named): no scoping/no change. A named project that
  # doesn't match anything is a real error, not a silent no-op — the agent
  # should call list_projects and retry rather than the node landing
  # unscoped or unfiltered because of a typo.
  defp resolve_project_id(nil), do: {:ok, nil}

  defp resolve_project_id(name) do
    case Memory.find_project(name) do
      nil -> {:error, :unknown_project}
      project -> {:ok, project.id}
    end
  end

  defp unknown_project_message(name),
    do: "Nie znalazłem projektu \"#{name}\" — sprawdź listę przez list_projects."

  defp tool_get_node(readable_levels, %{id: id}) do
    case Memory.get_node_accessible(readable_levels, id) do
      nil ->
        {:ok, "Node not found: #{id}"}

      node ->
        processed = if node.processed_at, do: "yes", else: "no (in slipbox)"
        {:ok, "Node #{id}:\nContent: #{node.content}\nProcessed: #{processed}"}
    end
  end

  defp tool_find_similar(readable_levels, %{id: id} = args) do
    limit = Map.get(args, :limit, 5)

    case Memory.get_node_accessible(readable_levels, id) do
      nil ->
        {:ok, "Node not found: #{id}"}

      node ->
        case Memory.similar_nodes(node, readable_levels, limit: limit) do
          [] ->
            {:ok, "No similar nodes found for #{id}."}

          results ->
            lines =
              Enum.map(results, fn {n, distance} ->
                "- [#{n.id}] (similarity #{Float.round(1.0 - distance, 2)}) #{n.content}"
              end)

            {:ok, "Nodes most similar to [#{id}]:\n#{Enum.join(lines, "\n")}"}
        end
    end
  end

  defp tool_create_node(user_id, write_access, %{content: content} = args) do
    project_name = Map.get(args, :project)

    case resolve_project_id(project_name) do
      {:ok, project_id} ->
        case Voyage.embed_query(content) do
          {:ok, embedding} ->
            now = DateTime.utc_now() |> DateTime.truncate(:second)

            case Memory.create_node(user_id, write_access, %{
                   content: content,
                   embedding: embedding,
                   processed_at: now,
                   project_id: project_id
                 }) do
              {:ok, node} ->
                {:ok, "Created node: #{node.id}"}

              {:error, changeset} ->
                {:ok, "Failed to create node: #{inspect(changeset.errors)}"}
            end

          {:error, reason} ->
            {:ok, "Failed to generate embedding: #{inspect(reason)}"}
        end

      {:error, :unknown_project} ->
        {:ok, unknown_project_message(project_name)}
    end
  end

  defp tool_update_node(readable_levels, %{id: id, content: content} = args) do
    project_name = Map.get(args, :project)

    case resolve_project_id(project_name) do
      {:ok, project_id} ->
        case Voyage.embed_query(content) do
          {:ok, embedding} ->
            attrs = %{content: content, embedding: embedding}
            # Only touch project_id when the agent explicitly named one —
            # most update_node calls are content-only fixes and must not
            # silently clear an existing project attribution.
            attrs = if project_name, do: Map.put(attrs, :project_id, project_id), else: attrs

            case Memory.update_node_accessible(readable_levels, id, attrs) do
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

      {:error, :unknown_project} ->
        {:ok, unknown_project_message(project_name)}
    end
  end

  defp tool_create_link(user_id, %{node_a_id: a, node_b_id: b} = args) do
    opts = if args[:context], do: [context: args[:context]], else: []

    case Memory.create_link(user_id, a, b, opts) do
      {:ok, _link} ->
        {:ok, "Linked #{a} <-> #{b}"}

      {:error, changeset} ->
        {:ok, "Failed to create link: #{inspect(changeset.errors)}"}
    end
  end

  defp tool_mark_processed(readable_levels, %{id: id}) do
    case Memory.mark_processed_accessible(readable_levels, id) do
      :ok -> {:ok, "Marked #{id} as processed"}
      {:error, :not_found} -> {:ok, "Node not found: #{id}"}
    end
  end

  defp tool_delete_node(readable_levels, %{id: id}) do
    case Memory.delete_node_accessible(readable_levels, id) do
      {:ok, _node} ->
        {:ok, "Deleted node: #{id}"}

      {:error, :not_found} ->
        {:ok, "Node not found: #{id}"}
    end
  end

  defp tool_delete_link(readable_levels, %{node_a_id: a, node_b_id: b}) do
    case Memory.delete_link_accessible(readable_levels, a, b) do
      {:ok, _link} ->
        {:ok, "Deleted link: #{a} <-> #{b}"}

      {:error, :not_found} ->
        {:ok, "Link not found: #{a} <-> #{b}"}
    end
  end

  defp tool_list_links(readable_levels, %{id: id}) do
    linked = Memory.get_node_links_with_context_accessible(readable_levels, id)

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

  defp tool_graph_stats(write_access, _args) do
    stats = Memory.graph_stats_by_access(write_access)

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
end
