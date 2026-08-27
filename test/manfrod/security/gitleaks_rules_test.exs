defmodule Manfrod.Security.GitleaksRulesTest do
  use ExUnit.Case, async: true

  alias Manfrod.Security.GitleaksRules

  @fixture """
  title = "gitleaks config"

  [[rules]]
  id = "adafruit-api-key"
  description = "Adafruit API Key"
  regex = '''(?i)adafruit[a-z0-9_-]{32}'''
  keywords = ["adafruit"]

  [[rules.allowlists]]
  regexes = ['''sample-fake-adafruit-key''']

  [[rules]]
  id = "generic-password"
  description = "Generic password assignment"
  regex = '''password\\s*=\\s*"[a-z0-9]{8,}"'''
  keywords = ["password"]

  [[rules]]
  id = "no-regex-rule"
  description = "A rule with no regex (e.g. file-based)"
  keywords = ["pkcs12"]
  """

  describe "parse/1" do
    test "extracts id, regex, and keywords per rule, skipping rules without a regex" do
      rules = GitleaksRules.parse(@fixture)

      assert length(rules) == 2
      assert Enum.map(rules, & &1.id) == ["adafruit-api-key", "generic-password"]

      adafruit = Enum.find(rules, &(&1.id == "adafruit-api-key"))
      assert adafruit.keywords == ["adafruit"]
      assert Regex.match?(adafruit.regex, "adafruit" <> String.duplicate("a1", 16))
    end
  end

  setup do
    GitleaksRules.load!()
    :ok
  end

  describe "matches?/1 (real vendored ruleset)" do
    test "matches a Stripe-format live key" do
      fake_key = "sk_liv" <> "e_4eC39HqLyjWDarjtT1zdp7dc"
      assert {true, _rule_id} = GitleaksRules.matches?(fake_key)
    end

    test "matches a GitHub PAT" do
      fake_pat = "gh" <> "p_wWPw5k4aXcaT4fNP0UcnZwJUVFk6LO0pINUx"
      assert {true, _rule_id} = GitleaksRules.matches?(fake_pat)
    end

    test "does not match an ordinary sentence" do
      refute GitleaksRules.matches?("hej, jak leci dzisiaj w pracy")
    end

    test "loads at least 200 rules from the vendored file" do
      assert length(GitleaksRules.rules()) > 200
    end
  end
end
