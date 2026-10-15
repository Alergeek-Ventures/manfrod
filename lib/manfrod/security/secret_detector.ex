defmodule Manfrod.Security.SecretDetector do
  @moduledoc false

  alias Manfrod.Security.GitleaksRules

  @url_regex ~r/\bhttps?:\/\/\S+/

  # A labelled credential ("api key: ...", "hasło=...") whose value is a
  # 16+ character run mixing letters and digits.
  @labelled_secret ~r/(?:api[_ -]?key|apikey|token|secret|password|passwd|hasło|haslo|klucz)\s*[:=]\s*["'`]?(?=[^\s"'`]*\d)(?=[^\s"'`]*[a-z])[^\s"'`]{16,}/iu

  @spec contains_secret?(String.t() | nil) :: boolean()
  def contains_secret?(text) when is_binary(text) do
    text = Regex.replace(@url_regex, text, " ")
    Regex.match?(@labelled_secret, text) or match?({true, _rule_id}, GitleaksRules.matches?(text))
  end

  def contains_secret?(_), do: false

  @polish_chars ~r/[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/
  @polish_words ~w(nie jest tutaj proszę cześć siema dzięki masz jak co gdzie kiedy jestem może właśnie)

  @spec language_hint(String.t()) :: :pl | :en
  def language_hint(text) when is_binary(text) do
    downcased = String.downcase(text)
    words = String.split(downcased, ~r/[^\p{L}]+/u, trim: true)

    cond do
      Regex.match?(@polish_chars, text) -> :pl
      Enum.any?(words, &(&1 in @polish_words)) -> :pl
      true -> :en
    end
  end

  def language_hint(_), do: :pl
end
