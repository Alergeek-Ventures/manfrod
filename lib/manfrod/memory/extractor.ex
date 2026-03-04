defmodule Manfrod.Memory.Extractor do
  @moduledoc """
  Extracts knowledge nodes and links from conversations via LLM.

  Flow:
  1. Fetch pending messages for the user from DB
  2. Generate conversation summary
  3. Close conversation (create record, link messages)
  4. Extract facts from conversation
  5. Store nodes with conversation_id (in slipbox)
  6. Create links between co-extracted facts
  """

  require Logger
  alias Manfrod.{Events, LLM, Memory, Voyage}

  @summary_prompt """
  Summarize this conversation in 2-3 sentences. Focus on:
  - What was discussed
  - Key decisions or outcomes
  - Any action items or follow-ups

  Conversation:
  """

  @extraction_prompt """
  Extract knowledge worth remembering from this conversation.
  Return JSON: {"nodes": ["fact 1", "fact 2"], "links": [[0, 1]]}

  Rules:
  - Each node = one atomic fact (1-2 sentences max)
  - Only extract long-term valuable info (facts about user, decisions, preferences, context)
  - Links connect related nodes (0-indexed)
  - Return {"nodes": [], "links": []} if nothing worth remembering
  - The conversation may contain multiple exchanges - extract from all of them

  Conversation:
  """

  @doc """
  Fire-and-forget extraction triggered on idle for a specific user.
  Fetches pending messages from DB, processes them, stores results.
  """
  def extract_async(user_id) do
    Task.start(fn -> extract_and_store(user_id) end)
    :ok
  end

  @doc """
  Synchronous extraction and storage for a specific user.
  Returns {:ok, conversation, node_ids} or {:error, reason}.
  """
  def extract_and_store(user_id) do
    messages = Memory.get_pending_messages(user_id)

    if messages == [] do
      Logger.debug("Extractor: no pending messages to process for user #{user_id}")
      {:ok, nil, []}
    else
      do_extract_and_store(user_id, messages)
    end
  end

  defp do_extract_and_store(user_id, messages) do
    conversation_text = format_messages(messages)

    Events.broadcast(:extraction_started, %{
      user_id: user_id,
      source: :extractor,
      meta: %{message_count: length(messages)}
    })

    with {:ok, summary} <- generate_summary(conversation_text),
         {:ok, conversation} <- Memory.close_conversation(user_id, %{summary: summary}),
         {:ok, node_ids} <- extract_and_create_nodes(user_id, conversation_text, conversation.id) do
      Logger.info(
        "Extracted conversation #{conversation.id} for user #{user_id}: #{length(node_ids)} nodes, summary: #{String.slice(summary, 0, 50)}..."
      )

      Events.broadcast(:extraction_completed, %{
        user_id: user_id,
        source: :extractor,
        meta: %{
          conversation_id: conversation.id,
          node_count: length(node_ids),
          summary_preview: String.slice(summary, 0, 100)
        }
      })

      {:ok, conversation, node_ids}
    else
      {:error, :no_pending_messages} ->
        Logger.debug("Extractor: no pending messages (race condition) for user #{user_id}")
        {:ok, nil, []}

      {:error, reason} = err ->
        Logger.error("Extraction failed for user #{user_id}: #{inspect(reason)}")

        Events.broadcast(:extraction_failed, %{
          user_id: user_id,
          source: :extractor,
          meta: %{reason: inspect(reason)}
        })

        err
    end
  end

  defp format_messages(messages) do
    messages
    |> Enum.map(fn message ->
      role = if message.role == "user", do: "User", else: "Assistant"
      "#{role}: #{message.content}"
    end)
    |> Enum.join("\n\n")
  end

  defp generate_summary(conversation_text) do
    prompt = @summary_prompt <> conversation_text
    messages = [ReqLLM.Context.user(prompt)]

    case LLM.generate_text(messages, purpose: :extractor) do
      {:ok, response} ->
        summary = ReqLLM.Response.text(response) |> String.trim()
        {:ok, summary}

      error ->
        error
    end
  end

  defp extract_and_create_nodes(user_id, conversation_text, conversation_id) do
    with {:ok, %{"nodes" => [_ | _] = texts, "links" => links}} <-
           extract_facts(conversation_text),
         {:ok, embeddings} <- Voyage.embed(texts) do
      node_ids =
        texts
        |> Enum.zip(embeddings)
        |> Enum.map(fn {content, embedding} ->
          {:ok, node} =
            Memory.create_node(user_id, %{
              content: content,
              embedding: embedding,
              conversation_id: conversation_id
              # processed_at is nil by default (slipbox)
            })

          node.id
        end)

      for [a, b] <- links, a < length(node_ids), b < length(node_ids) do
        Memory.create_link(user_id, Enum.at(node_ids, a), Enum.at(node_ids, b))
      end

      Logger.info("Created #{length(node_ids)} nodes, #{length(links)} links for user #{user_id}")
      {:ok, node_ids}
    else
      {:ok, %{"nodes" => []}} ->
        Logger.info("No facts worth extracting from conversation")
        {:ok, []}

      {:error, _} = err ->
        err
    end
  end

  defp extract_facts(conversation_text) do
    prompt = @extraction_prompt <> conversation_text
    messages = [ReqLLM.Context.user(prompt)]

    case LLM.generate_text(messages, purpose: :extractor) do
      {:ok, response} ->
        text = ReqLLM.Response.text(response)
        parse_json(text)

      error ->
        error
    end
  end

  defp parse_json(text) do
    # Strip markdown code fences if present
    json =
      case Regex.run(~r/```(?:json)?\s*(.*?)\s*```/s, text) do
        [_, inner] -> inner
        nil -> text
      end

    case Jason.decode(String.trim(json)) do
      {:ok, %{"nodes" => nodes, "links" => links}} when is_list(nodes) and is_list(links) ->
        {:ok, %{"nodes" => nodes, "links" => links}}

      {:ok, %{"nodes" => nodes}} when is_list(nodes) ->
        {:ok, %{"nodes" => nodes, "links" => []}}

      _ ->
        {:error, :invalid_json}
    end
  end
end
