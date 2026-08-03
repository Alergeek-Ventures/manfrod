defmodule Manfrod.PricingTest do
  use ExUnit.Case, async: true

  alias Manfrod.Pricing

  @gpt "openai/gpt-5.6-luna"
  @deepseek "deepseek/deepseek-v4-flash"

  describe "cost/2" do
    test "prices plain input and output at the headline rates" do
      cost = Pricing.cost(@gpt, %{input_tokens: 1_000_000, output_tokens: 1_000_000})

      assert_in_delta cost, 0.10 + 0.60, 0.000001
    end

    test "treats cached tokens as a discounted subset of input, not an addition" do
      # 1M input of which 600K was a cache hit: 400K fresh @ $0.10 + 600K cached @ $0.01
      cost =
        Pricing.cost(@gpt, %{
          input_tokens: 1_000_000,
          output_tokens: 0,
          cached_tokens: 600_000
        })

      assert_in_delta cost, 0.4 * 0.10 + 0.6 * 0.01, 0.000001
    end

    test "caching is cheaper than not caching for the same input volume" do
      usage = %{input_tokens: 1_000_000, output_tokens: 10_000, cached_tokens: 800_000}

      assert Pricing.cost(@gpt, usage) < Pricing.uncached_cost(@gpt, usage)
    end

    test "charges the higher cache-write rate only above the threshold" do
      below = Pricing.cost(@gpt, %{cache_creation_tokens: 100_000})
      above = Pricing.cost(@gpt, %{cache_creation_tokens: 300_000})

      assert_in_delta below, 0.1 * 0.125, 0.000001
      assert_in_delta above, 0.3 * 0.25, 0.000001
    end

    test "deepseek has no cache-write charge" do
      assert Pricing.cost(@deepseek, %{cache_creation_tokens: 500_000}) == 0.0
    end

    test "deepseek prices below gpt for identical usage" do
      usage = %{input_tokens: 500_000, output_tokens: 50_000}

      assert Pricing.cost(@deepseek, usage) < Pricing.cost(@gpt, usage)
    end

    test "free helper models cost nothing" do
      usage = %{input_tokens: 5_000_000, output_tokens: 1_000_000}

      assert Pricing.cost("llama-3.1-8b-instant", usage) == 0.0
      assert Pricing.free?("llama-3.1-8b-instant")
    end

    test "an unknown model costs nothing rather than crashing" do
      assert Pricing.cost("some/unlisted-model", %{input_tokens: 1_000}) == 0.0
      assert Pricing.cost(nil, %{input_tokens: 1_000}) == 0.0
    end

    test "known?/1 separates a genuinely free model from an unpriced one" do
      # Both cost $0, but only one of them should read as "free" to a human.
      assert Pricing.known?("llama-3.1-8b-instant")
      refute Pricing.known?("some/unlisted-model")
    end

    test "kimi prices above gpt for identical usage" do
      usage = %{input_tokens: 1_000_000, output_tokens: 100_000}

      assert Pricing.cost("moonshotai/kimi-k2.5", usage) > Pricing.cost(@gpt, usage)
    end

    test "accepts string keys and tolerates missing or nil counts" do
      assert_in_delta Pricing.cost(@gpt, %{"input_tokens" => 1_000_000}), 0.10, 0.000001
      assert Pricing.cost(@gpt, %{}) == 0.0
      assert Pricing.cost(@gpt, %{input_tokens: nil, output_tokens: nil}) == 0.0
    end

    test "does not go negative when cached exceeds reported input" do
      cost = Pricing.cost(@gpt, %{input_tokens: 100, cached_tokens: 5_000})

      assert cost >= 0.0
    end
  end

  describe "label/1" do
    test "names known models and passes unknown ids through" do
      assert Pricing.label(@gpt) == "GPT-5.6 Luna"
      assert Pricing.label("some/unlisted-model") == "some/unlisted-model"
    end
  end
end
