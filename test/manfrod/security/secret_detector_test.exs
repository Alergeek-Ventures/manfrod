defmodule Manfrod.Security.SecretDetectorTest do
  use ExUnit.Case, async: true

  alias Manfrod.Security.SecretDetector

  describe "contains_secret?/1" do
    test "flags high-entropy tokens" do
      assert SecretDetector.contains_secret?(
               "tutaj klucz: qX7pL2vR9zK4mN8wJ3hT6yB1cF5dS0gA-uE_oP"
             )

      assert SecretDetector.contains_secret?(
               "token=Zm9vYmFyLXJhbmRvbS1sb29raW5nLXRlc3QtdG9rZW4tMTIzNDU"
             )
    end

    test "does not flag ordinary sentences" do
      refute SecretDetector.contains_secret?("hej siema, jak leci? co u ciebie słychać dzisiaj")
      refute SecretDetector.contains_secret?("zwykle zdanie bez zadnych sekretow tylko slowa")
    end

    test "does not flag a normal URL" do
      refute SecretDetector.contains_secret?(
               "sprawdz to na https://example.com/some/very/long/path/that/is/normal"
             )
    end

    test "does not flag a low-entropy known-looking key (limited alphabet)" do
      refute SecretDetector.contains_secret?("AKIAIOSFODNN7EXAMPLE")
    end

    test "ignores nil/non-string input" do
      refute SecretDetector.contains_secret?(nil)
    end
  end

  describe "language_hint/1" do
    test "detects Polish from diacritics" do
      assert SecretDetector.language_hint("cześć, jak się masz?") == :pl
    end

    test "detects Polish from common words without diacritics" do
      assert SecretDetector.language_hint("hej co tam jak leci") == :pl
    end

    test "falls back to English otherwise" do
      assert SecretDetector.language_hint("hey what's up, how are you doing today") == :en
    end
  end
end
