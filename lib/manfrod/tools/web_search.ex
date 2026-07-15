defmodule Manfrod.Tools.WebSearch do
  @moduledoc """
  Web search tool (Brave Search) for the live agent.
  """

  def definitions do
    [
      ReqLLM.Tool.new!(
        name: "web_search",
        description:
          "Search the web for current information. Use this when you need up-to-date facts, news, documentation, or anything not in your notes.",
        parameter_schema: [
          query: [
            type: :string,
            required: true,
            doc: "Search query - what to look up on the web"
          ]
        ],
        callback: &web_search/1
      )
    ]
  end

  defp web_search(%{query: query}) do
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
end
