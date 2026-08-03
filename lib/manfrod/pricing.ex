defmodule Manfrod.Pricing do
  @moduledoc """
  Per-model token pricing and cost calculation.

  Prices are USD per million tokens, taken from the provider's public pricing
  page. Costs are computed from the token counts reported on
  `:llm_call_succeeded` events, so a price change here only affects rollups
  computed after the change — already-rolled-up `cost_usd` values are frozen at
  the price that was in effect when they were computed.

  ## Cached input

  `cached_tokens` reported by the provider is a *subset* of `input_tokens`, not
  an addition to it. Billable fresh input is therefore
  `input_tokens - cached_tokens`, charged at the full input rate, while the
  cached portion is charged at the (much cheaper) cached rate.

  ## Cache writes

  Models that charge for populating the prompt cache expose a
  `cache_write_per_mtok` rate. Some tiers charge more once the cached prefix
  crosses a token threshold (`cache_write_threshold`), in which case
  `cache_write_above_per_mtok` applies to a write that large.

  Models with no entry here (or explicitly free ones) cost nothing — the free
  Groq helper models used for query expansion, thread titles, and the response
  gate fall in this bucket.
  """

  @unknown_model_price %{
    input_per_mtok: 0.0,
    output_per_mtok: 0.0,
    cached_input_per_mtok: 0.0,
    cache_write_per_mtok: 0.0,
    cache_write_above_per_mtok: nil,
    cache_write_threshold: nil,
    label: "unknown",
    free: true
  }

  @prices %{
    "openai/gpt-5.6-luna" => %{
      input_per_mtok: 0.10,
      output_per_mtok: 0.60,
      cached_input_per_mtok: 0.01,
      cache_write_per_mtok: 0.125,
      cache_write_above_per_mtok: 0.25,
      cache_write_threshold: 272_000,
      label: "GPT-5.6 Luna",
      free: false
    },
    "deepseek/deepseek-v4-flash" => %{
      input_per_mtok: 0.0882,
      output_per_mtok: 0.1764,
      cached_input_per_mtok: 0.01764,
      cache_write_per_mtok: 0.0,
      cache_write_above_per_mtok: nil,
      cache_write_threshold: nil,
      label: "DeepSeek V4 Flash",
      free: false
    },
    "moonshotai/kimi-k2.5" => %{
      input_per_mtok: 0.60,
      output_per_mtok: 3.00,
      cached_input_per_mtok: 0.10,
      cache_write_per_mtok: 0.0,
      cache_write_above_per_mtok: nil,
      cache_write_threshold: nil,
      label: "Kimi K2.5",
      free: false
    },
    # Groq free tier — genuinely $0, used for query expansion, thread titles,
    # and the response gate.
    "llama-3.1-8b-instant" => %{
      input_per_mtok: 0.0,
      output_per_mtok: 0.0,
      cached_input_per_mtok: 0.0,
      cache_write_per_mtok: 0.0,
      cache_write_above_per_mtok: nil,
      cache_write_threshold: nil,
      label: "Llama 3.1 8B Instant",
      free: true
    }
  }

  @doc """
  Returns the full pricing table, keyed by model id.
  """
  @spec table() :: map()
  def table, do: @prices

  @doc """
  Returns the pricing entry for a model, or a zero-cost entry if unknown.
  """
  @spec for_model(String.t() | nil) :: map()
  def for_model(model) when is_binary(model), do: Map.get(@prices, model, @unknown_model_price)
  def for_model(_model), do: @unknown_model_price

  @doc """
  Human-friendly display name for a model id.
  """
  @spec label(String.t() | nil) :: String.t()
  def label(nil), do: "unknown"

  def label(model) when is_binary(model) do
    case Map.get(@prices, model) do
      nil -> model
      %{label: label} -> label
    end
  end

  @doc """
  True when the model has no per-token cost (free tier or unpriced helper).
  """
  @spec free?(String.t() | nil) :: boolean()
  def free?(model), do: for_model(model).free

  @doc """
  True when the model has an explicit entry in the pricing table.

  A model that is missing here is costed at $0, which would silently understate
  spend after a model switch — the analytics page surfaces this so an unpriced
  model reads as "unknown", not as "free".
  """
  @spec known?(String.t() | nil) :: boolean()
  def known?(model) when is_binary(model), do: Map.has_key?(@prices, model)
  def known?(_model), do: false

  @doc """
  Cost in USD for a single call's token usage.

  `usage` accepts either atom or string keys and tolerates missing/nil counts.

      iex> Manfrod.Pricing.cost("openai/gpt-5.6-luna", %{input_tokens: 1_000_000, output_tokens: 0})
      0.1
  """
  @spec cost(String.t() | nil, map()) :: float()
  def cost(model, usage) when is_map(usage) do
    price = for_model(model)

    input = get_count(usage, :input_tokens)
    output = get_count(usage, :output_tokens)
    cached = get_count(usage, :cached_tokens)
    cache_write = get_count(usage, :cache_creation_tokens)

    # `cached` is a subset of `input`; never let a provider quirk drive the
    # fresh-input count negative.
    fresh_input = max(input - cached, 0)

    per_mtok(fresh_input, price.input_per_mtok) +
      per_mtok(cached, price.cached_input_per_mtok) +
      per_mtok(output, price.output_per_mtok) +
      cache_write_cost(cache_write, price)
  end

  @doc """
  Cost in USD for aggregated token totals.

  Same shape as `cost/2` — kept as a distinct name so call sites reading from
  rollup rows are explicit about aggregating rather than pricing one call.
  """
  @spec cost_for_totals(String.t() | nil, map()) :: float()
  def cost_for_totals(model, totals), do: cost(model, totals)

  @doc """
  What the same token usage *would* have cost without any prompt caching —
  every input token billed at the full input rate. Used to show cache savings.
  """
  @spec uncached_cost(String.t() | nil, map()) :: float()
  def uncached_cost(model, usage) when is_map(usage) do
    price = for_model(model)

    input = get_count(usage, :input_tokens)
    output = get_count(usage, :output_tokens)

    per_mtok(input, price.input_per_mtok) + per_mtok(output, price.output_per_mtok)
  end

  defp cache_write_cost(0, _price), do: 0.0

  defp cache_write_cost(tokens, %{
         cache_write_above_per_mtok: above,
         cache_write_threshold: threshold
       })
       when is_number(above) and is_integer(threshold) and tokens > threshold do
    per_mtok(tokens, above)
  end

  defp cache_write_cost(tokens, %{cache_write_per_mtok: base}), do: per_mtok(tokens, base)

  defp per_mtok(tokens, rate) when is_number(tokens) and is_number(rate) do
    tokens / 1_000_000 * rate
  end

  defp get_count(usage, key) do
    value = Map.get(usage, key) || Map.get(usage, to_string(key)) || 0

    case value do
      n when is_integer(n) -> n
      n when is_float(n) -> trunc(n)
      _ -> 0
    end
  end
end
