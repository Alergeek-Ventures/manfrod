defmodule Manfrod.Memory.QueryExpander do
  @moduledoc """
  Expands user queries into multiple search queries for improved retrieval.

  Uses DeepSeek V4 Flash for fast, reliable query expansion.
  Generates query variations that capture different phrasings and semantic
  angles of the original query, improving recall in semantic search.

  ## Example

      iex> QueryExpander.expand("what was that project?")
      {:ok, [
        "what was that project?",
        "previous project we discussed",
        "project mentioned in earlier conversation"
      ]}
  """

  alias Manfrod.LLM

  # DeepSeek V4 Flash over OpenRouter: fast and cheap enough for a call that
  # sits in front of every memory search.
  @model "deepseek/deepseek-v4-flash"
  @provider :openrouter

  @system_message "You are a query expansion assistant. Rewrite search queries into multiple variations to improve retrieval. Always output valid JSON arrays only, no other text."

  @expansion_prompt """
  Rewrite this query into 3 different search queries. Include the original as first item.

  Rules:
  - Each query captures a different angle or phrasing
  - Keep queries concise (under 15 words)
  - Output ONLY a JSON array of strings

  Query: {{QUERY}}
  """

  @doc """
  Expands a query into multiple search queries using LLM.

  Returns `{:ok, [query1, query2, query3]}` on success.
  Returns `{:error, reason}` on failure, with fallback to original query.

  ## Options

    * `:timeout_ms` - Request timeout (default: 10_000)
  """
  @spec expand(String.t(), keyword()) :: {:ok, [String.t()]} | {:error, term()}
  def expand(query, opts \\ []) do
    timeout_ms = Keyword.get(opts, :timeout_ms, 10_000)

    prompt = String.replace(@expansion_prompt, "{{QUERY}}", query)

    messages = [
      ReqLLM.Context.system(@system_message),
      ReqLLM.Context.user(prompt)
    ]

    case LLM.generate_simple(@model, messages,
           provider: @provider,
           purpose: :query_expansion,
           timeout_ms: timeout_ms
         ) do
      {:ok, response} ->
        parse_expansion(response, query)

      {:error, _reason} ->
        # Fallback: return original query on error
        {:ok, [query]}
    end
  end

  # Parse the LLM response into a list of queries
  defp parse_expansion(response, original_query) do
    # Clean up response - remove markdown code blocks if present
    cleaned =
      response
      |> String.trim()
      |> String.replace(~r/^```json\s*/, "")
      |> String.replace(~r/\s*```$/, "")
      |> String.trim()

    case Jason.decode(cleaned) do
      {:ok, queries} when is_list(queries) ->
        # Ensure original query is first and all items are strings
        queries =
          queries
          |> Enum.filter(&is_binary/1)
          |> Enum.take(5)

        # Always include original query first
        queries =
          if original_query in queries do
            [original_query | Enum.reject(queries, &(&1 == original_query))]
          else
            [original_query | queries]
          end

        {:ok, Enum.take(queries, 3)}

      {:ok, _} ->
        # Not a list, fallback
        {:ok, [original_query]}

      {:error, _} ->
        # JSON parse failed, fallback
        {:ok, [original_query]}
    end
  end
end
