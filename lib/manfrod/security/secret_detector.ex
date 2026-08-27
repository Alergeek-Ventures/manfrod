defmodule Manfrod.Security.SecretDetector do
  @moduledoc false

  @min_token_length 16
  @entropy_threshold 4.0
  @token_regex ~r/[A-Za-z0-9\-_\/\+=]{#{@min_token_length},}/

  @spec contains_secret?(String.t() | nil) :: boolean()
  def contains_secret?(text) when is_binary(text) do
    text
    |> extract_tokens()
    |> Enum.any?(&looks_like_secret?/1)
  end

  def contains_secret?(_), do: false

  defp extract_tokens(text), do: Regex.scan(@token_regex, text) |> List.flatten()

  defp looks_like_secret?(token) do
    String.length(token) >= @min_token_length and shannon_entropy(token) > @entropy_threshold
  end

  defp shannon_entropy(token) do
    length = String.length(token)

    token
    |> String.graphemes()
    |> Enum.frequencies()
    |> Enum.reduce(0.0, fn {_char, count}, acc ->
      p = count / length
      acc - p * :math.log2(p)
    end)
  end

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
