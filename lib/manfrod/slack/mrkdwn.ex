defmodule Manfrod.Slack.Mrkdwn do
  @moduledoc """
  Converts Markdown (as produced by LLMs) to Slack's mrkdwn format.

  Key differences handled:

  - `**bold**` / `__bold__` → `*bold*`
  - `*italic*` / `_italic_` → `_italic_` (only bare single `*`)
  - `# Heading` → `*Heading*` (bold line)
  - `[text](url)` → `<url|text>`
  - `- item` / `* item` → `• item` (unordered lists)
  - Numbered lists `1. item` are left as-is (Slack renders them fine)
  - Fenced code blocks and inline code are preserved as-is
  """

  # Pre-compiled regexes as module attributes (compiled once at compile time)
  @heading_re ~r/^(\#{1,6})\s+(.+)$/
  @unordered_list_re ~r/^(\s*)[-*]\s+(.+)$/
  @link_re ~r/\[([^\]]+)\]\(([^)]+)\)/
  @bold_double_star_re ~r/\*\*(.+?)\*\*/
  @bold_double_under_re ~r/__(.+?)__/
  @italic_star_re ~r/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/
  @strikethrough_re ~r/~~(.+?)~~/
  @fenced_code_re ~r/```[\s\S]*?```/
  @inline_code_re ~r/`[^`]+`/

  # Null-byte placeholder to safely separate bold conversion from italic
  @bold_placeholder "\x00B"

  @doc """
  Convert a Markdown string to Slack mrkdwn.
  """
  @spec from_markdown(String.t()) :: String.t()
  def from_markdown(text) when is_binary(text) do
    text
    |> preserve_code_blocks()
    |> convert_lines()
    |> restore_code_blocks()
  end

  def from_markdown(other), do: other

  # ---------------------------------------------------------------------------
  # Code block preservation
  # ---------------------------------------------------------------------------

  @code_block_placeholder "%%CODEBLOCK_"
  @inline_code_placeholder "%%INLINECODE_"

  defp preserve_code_blocks(text) do
    {text, blocks} = extract_pattern(text, @fenced_code_re, @code_block_placeholder)
    {text, inlines} = extract_pattern(text, @inline_code_re, @inline_code_placeholder)
    {text, blocks, inlines}
  end

  defp extract_pattern(text, regex, prefix) do
    matches = Regex.scan(regex, text) |> Enum.map(&hd/1)

    {replaced, _idx} =
      Enum.reduce(matches, {text, 0}, fn match, {txt, idx} ->
        {String.replace(txt, match, "#{prefix}#{idx}%%", global: false), idx + 1}
      end)

    {replaced, matches}
  end

  defp restore_code_blocks({text, blocks, inlines}) do
    text = restore_pattern(text, blocks, @code_block_placeholder)
    restore_pattern(text, inlines, @inline_code_placeholder)
  end

  defp restore_pattern(text, matches, prefix) do
    matches
    |> Enum.with_index()
    |> Enum.reduce(text, fn {original, idx}, txt ->
      String.replace(txt, "#{prefix}#{idx}%%", original)
    end)
  end

  # ---------------------------------------------------------------------------
  # Line-by-line conversion
  # ---------------------------------------------------------------------------

  defp convert_lines({text, blocks, inlines}) do
    converted =
      text
      |> String.split("\n")
      |> Enum.map(&convert_line/1)
      |> Enum.join("\n")

    {converted, blocks, inlines}
  end

  defp convert_line(line) do
    trimmed = String.trim_leading(line)

    cond do
      match = Regex.run(@heading_re, trimmed) ->
        [_, _hashes, heading_text] = match
        "*#{convert_inline(heading_text)}*"

      match = Regex.run(@unordered_list_re, line) ->
        [_, indent, item_text] = match
        "#{indent}• #{convert_inline(item_text)}"

      true ->
        convert_inline(line)
    end
  end

  # ---------------------------------------------------------------------------
  # Inline formatting
  # ---------------------------------------------------------------------------

  defp convert_inline(text) do
    text
    # Links: [text](url) → <url|text>
    |> String.replace(@link_re, "<\\2|\\1>")
    # Bold: **text** / __text__ → placeholder around content (safe from italic pass)
    |> String.replace(@bold_double_star_re, "#{@bold_placeholder}\\1#{@bold_placeholder}")
    |> String.replace(@bold_double_under_re, "#{@bold_placeholder}\\1#{@bold_placeholder}")
    # Italic: remaining single *text* → _text_
    |> then(&Regex.replace(@italic_star_re, &1, "_\\1_"))
    # Strikethrough: ~~text~~ → ~text~
    |> String.replace(@strikethrough_re, "~\\1~")
    # Replace bold placeholder with actual Slack bold marker
    |> String.replace(@bold_placeholder, "*")
  end
end
