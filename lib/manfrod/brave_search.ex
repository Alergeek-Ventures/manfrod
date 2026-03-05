defmodule Manfrod.BraveSearch do
  @moduledoc """
  Brave Search API client for web search.

  Uses the Brave Web Search API to find current information on the web.
  Results are formatted as compact text blocks suitable for LLM consumption.
  """

  @base_url "https://api.search.brave.com/res/v1"

  @doc """
  Search the web using Brave Search.

  Returns formatted search results as a string suitable for LLM tool output.

  ## Options

    * `:count` - Number of results to return (default: 5, max: 20)
    * `:freshness` - Filter by age: "pd" (past day), "pw" (past week),
      "pm" (past month), "py" (past year)
    * `:api_key` - Override API key

  ## Returns

    * `{:ok, formatted_string}` - Search results as text
    * `{:error, reason}` - On failure
  """
  def search(query, opts \\ []) when is_binary(query) do
    api_key = opts[:api_key] || Application.get_env(:manfrod, :brave_search_api_key)

    if is_nil(api_key) do
      {:error, :api_key_not_configured}
    else
      params =
        [q: query, count: opts[:count] || 5]
        |> maybe_add(:freshness, opts[:freshness])

      case Req.get("#{@base_url}/web/search",
             params: params,
             headers: [
               {"X-Subscription-Token", api_key},
               {"Accept", "application/json"}
             ]
           ) do
        {:ok, %{status: 200, body: body}} ->
          {:ok, format_results(query, body)}

        {:ok, %{status: 429}} ->
          {:error, :rate_limited}

        {:ok, %{status: status, body: body}} ->
          {:error, {status, body}}

        {:error, reason} ->
          {:error, reason}
      end
    end
  end

  defp format_results(query, body) do
    results = get_in(body, ["web", "results"]) || []

    if results == [] do
      "No web results found for: #{query}"
    else
      formatted =
        results
        |> Enum.with_index(1)
        |> Enum.map(fn {result, idx} ->
          title = result["title"] || "Untitled"
          url = result["url"] || ""
          description = result["description"] || "" |> strip_html_tags()
          age = format_age(result["page_age"])

          age_suffix = if age, do: " (#{age})", else: ""

          "#{idx}. #{title}#{age_suffix}\n   #{url}\n   #{description}"
        end)
        |> Enum.join("\n\n")

      "Web results for \"#{query}\":\n\n#{formatted}"
    end
  end

  defp strip_html_tags(text) do
    text
    |> String.replace(~r/<\/?strong>/, "")
    |> String.replace(~r/<\/?b>/, "")
    |> String.replace(~r/<\/?em>/, "")
  end

  defp format_age(nil), do: nil

  defp format_age(iso_string) when is_binary(iso_string) do
    case DateTime.from_iso8601(iso_string) do
      {:ok, dt, _offset} ->
        days = DateTime.diff(DateTime.utc_now(), dt, :day)

        cond do
          days == 0 -> "today"
          days == 1 -> "1 day ago"
          days < 30 -> "#{days} days ago"
          days < 365 -> "#{div(days, 30)} months ago"
          true -> "#{div(days, 365)} years ago"
        end

      _ ->
        nil
    end
  end

  defp maybe_add(params, _key, nil), do: params
  defp maybe_add(params, key, value), do: Keyword.put(params, key, value)
end
