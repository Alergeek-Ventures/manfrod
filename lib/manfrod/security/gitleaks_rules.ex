defmodule Manfrod.Security.GitleaksRules do
  @moduledoc """
  Loads and caches gitleaks' public regex ruleset
  (https://github.com/gitleaks/gitleaks/blob/master/config/gitleaks.toml) —
  ~220 provider-specific secret patterns (Stripe, AWS, GitHub, ...) — for
  `Manfrod.Security.SecretDetector` to check before falling back to its own
  generic entropy-free heuristic.

  Rules are cached in `:persistent_term` for fast concurrent reads. Booted
  from the vendored copy at `priv/security/gitleaks.toml` (so startup never
  depends on GitHub being reachable); `Manfrod.Workers.GitleaksRulesRefreshWorker`
  refreshes the cache from upstream on a daily cron, keeping the last good
  set on any fetch/parse failure.
  """

  require Logger

  @persistent_key {__MODULE__, :rules}
  @source_url "https://raw.githubusercontent.com/gitleaks/gitleaks/master/config/gitleaks.toml"

  @doc "Load the vendored ruleset into the cache. Call once at application boot."
  @spec load!() :: :ok
  def load!() do
    content = File.read!(vendored_path())
    :persistent_term.put(@persistent_key, parse(content))
    :ok
  end

  @doc """
  Fetch the latest ruleset from GitHub and replace the cache on success.
  Leaves the existing cache untouched on any network/parse failure.
  """
  @spec refresh() :: :ok | {:error, term()}
  def refresh() do
    case Req.get(@source_url, receive_timeout: 15_000) do
      {:ok, %{status: 200, body: body}} ->
        rules = parse(body)

        if rules == [] do
          Logger.warning("GitleaksRules: refresh parsed 0 rules, keeping previous cache")
          {:error, :empty_ruleset}
        else
          :persistent_term.put(@persistent_key, rules)
          Logger.info("GitleaksRules: refreshed #{length(rules)} rules from upstream")
          :ok
        end

      {:ok, %{status: status}} ->
        Logger.warning("GitleaksRules: refresh got HTTP #{status}, keeping previous cache")
        {:error, {:http_status, status}}

      {:error, reason} ->
        Logger.warning(
          "GitleaksRules: refresh failed (#{inspect(reason)}), keeping previous cache"
        )

        {:error, reason}
    end
  end

  @doc "Currently cached rules, or `[]` if `load!/0` hasn't run yet."
  @spec rules() :: [%{id: String.t(), regex: Regex.t(), keywords: [String.t()]}]
  def rules(), do: :persistent_term.get(@persistent_key, [])

  @doc "Whether `text` matches any known secret-provider pattern; returns the matching rule id."
  @spec matches?(String.t()) :: {true, String.t()} | false
  def matches?(text) do
    downcased = String.downcase(text)

    Enum.find_value(rules(), false, fn rule ->
      if keyword_hit?(downcased, rule.keywords) and Regex.match?(rule.regex, text) do
        {true, rule.id}
      end
    end)
  end

  defp keyword_hit?(_downcased, []), do: true

  defp keyword_hit?(downcased, keywords),
    do: Enum.any?(keywords, &String.contains?(downcased, &1))

  defp vendored_path(), do: Application.app_dir(:manfrod, "priv/security/gitleaks.toml")

  @doc false
  @spec parse(String.t()) :: [%{id: String.t(), regex: Regex.t(), keywords: [String.t()]}]
  def parse(content) do
    content
    |> String.split("\n")
    |> Enum.reduce({[], nil}, &parse_line/2)
    |> case do
      {rules, pending} -> [pending | rules] |> Enum.reject(&is_nil/1) |> finalize()
    end
  end

  defp parse_line("[[rules]]" <> _, {rules, pending}), do: {[pending | rules], nil}

  defp parse_line("id = " <> rest, {rules, pending}) do
    case Regex.run(~r/^"(.*)"$/, rest) do
      [_, id] -> {rules, %{id: id, regex: nil, keywords: []}}
      nil -> {rules, pending}
    end
  end

  defp parse_line("regex = " <> rest, {rules, %{} = pending}) do
    case extract_quoted(rest) do
      {:ok, pattern} -> {rules, %{pending | regex: pattern}}
      :error -> {rules, pending}
    end
  end

  defp parse_line("keywords = " <> rest, {rules, %{} = pending}) do
    keywords =
      ~r/"([^"]*)"/
      |> Regex.scan(rest, capture: :all_but_first)
      |> List.flatten()
      |> Enum.map(&String.downcase/1)

    {rules, %{pending | keywords: keywords}}
  end

  defp parse_line(_line, acc), do: acc

  defp extract_quoted(rest) do
    case Regex.run(~r/^'''(.*)'''$/, rest) || Regex.run(~r/^"(.*)"$/, rest) do
      [_, pattern] -> {:ok, pattern}
      nil -> :error
    end
  end

  defp finalize(entries) do
    entries
    |> Enum.reverse()
    |> Enum.filter(&(&1.regex not in [nil, ""]))
    |> Enum.flat_map(fn %{id: id, regex: pattern, keywords: keywords} ->
      case Regex.compile(pattern) do
        {:ok, regex} ->
          [%{id: id, regex: regex, keywords: keywords}]

        {:error, reason} ->
          Logger.debug("GitleaksRules: skipping #{id}, failed to compile: #{inspect(reason)}")
          []
      end
    end)
  end
end
