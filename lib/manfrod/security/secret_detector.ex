defmodule Manfrod.Security.SecretDetector do
  @moduledoc false

  alias Manfrod.Security.GitleaksRules

  @min_token_length 12
  @transition_ratio_threshold 0.6
  @token_regex ~r/[A-Za-z0-9\-_\/\+=]{#{@min_token_length},}/
  @url_regex ~r/\bhttps?:\/\/\S+/

  @spec contains_secret?(String.t() | nil) :: boolean()
  def contains_secret?(text) when is_binary(text) do
    text_without_urls = strip_urls(text)

    match?({true, _rule_id}, GitleaksRules.matches?(text_without_urls)) or
      text_without_urls |> extract_tokens() |> Enum.any?(&looks_like_secret?/1)
  end

  def contains_secret?(_), do: false

  defp strip_urls(text), do: Regex.replace(@url_regex, text, " ")

  defp extract_tokens(text), do: Regex.scan(@token_regex, text) |> List.flatten()

  defp looks_like_secret?(token) do
    String.length(token) >= @min_token_length and
      transition_ratio(token) >= @transition_ratio_threshold
  end

  defp transition_ratio(token) do
    chars = String.graphemes(token)
    pairs = Enum.zip(chars, tl(chars))
    transitions = Enum.count(pairs, fn {a, b} -> not same_char_class?(a, b) end)
    transitions / length(chars)
  end

  defp same_char_class?(a, b) do
    (lower?(a) and lower?(b)) or (upper?(a) and upper?(b)) or (digit?(a) and digit?(b))
  end

  defp lower?(c), do: c =~ ~r/[a-z]/
  defp upper?(c), do: c =~ ~r/[A-Z]/
  defp digit?(c), do: c =~ ~r/[0-9]/

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
