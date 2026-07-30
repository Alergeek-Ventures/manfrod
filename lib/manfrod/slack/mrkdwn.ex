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

  @doc """
  Convert Markdown to a `{fallback_text, blocks}` pair, promoting any
  markdown pipe table in `text` to a real Slack Block Kit `table` block.

  Slack does not render `| a | b |` pipe tables at all — they show up as
  raw text — and LLMs write them constantly regardless of prompt
  instructions not to. Rather than relying on the model to always call a
  table tool, every outbound response is passed through here so a
  markdown table becomes a real table no matter how it was produced.

  `blocks` is `nil` when `text` contains no table (the common case), so
  callers can send plain `text:` exactly as before. When present, `blocks`
  is a full replacement for the message body — `fallback_text` is only
  the accessibility/notification-preview text.
  """
  @spec to_blocks(String.t()) :: {String.t(), [map()] | nil}
  def to_blocks(text) when is_binary(text) do
    segments = text |> String.split("\n") |> segment_lines()

    if Enum.any?(segments, &match?({:table, _}, &1)) do
      {from_markdown(text), Enum.flat_map(segments, &segment_to_blocks/1)}
    else
      {from_markdown(text), nil}
    end
  end

  # ---------------------------------------------------------------------------
  # Markdown table detection
  # ---------------------------------------------------------------------------

  @max_table_rows 100
  @max_table_cols 20
  @table_sep_cell_re ~r/^:?-+:?$/

  defp segment_lines(lines), do: do_segment(lines, [], [])

  defp do_segment([], text_acc, segments), do: Enum.reverse(flush_text(text_acc, segments))

  defp do_segment([line | rest] = lines, text_acc, segments) do
    cond do
      match?([_ | _], rest) and table_row?(line) and table_separator?(hd(rest)) ->
        [_sep | after_sep] = rest
        {table_lines, remaining} = Enum.split_while(after_sep, &table_row?/1)
        rows = Enum.map([line | table_lines], &parse_row/1)
        segments = flush_text(text_acc, segments)
        do_segment(remaining, [], [{:table, rows} | segments])

      box_border_line?(line) or box_content_line?(line) ->
        {remaining, rows} = take_box_table(lines)

        if rows == [] do
          do_segment(rest, [line | text_acc], segments)
        else
          segments = flush_text(text_acc, segments)
          do_segment(remaining, [], [{:table, rows} | segments])
        end

      true ->
        do_segment(rest, [line | text_acc], segments)
    end
  end

  defp flush_text([], segments), do: segments

  defp flush_text(text_acc, segments) do
    text = text_acc |> Enum.reverse() |> Enum.join("\n")
    if String.trim(text) == "", do: segments, else: [{:text, text} | segments]
  end

  # -- Markdown pipe tables: `| a | b |` header + `|---|---|` separator ------

  defp table_row?(line), do: Regex.match?(~r/^\s*\|.+\|\s*$/, line)

  defp table_separator?(line) do
    cells = parse_row(line)
    cells != [] and Enum.all?(cells, &Regex.match?(@table_sep_cell_re, &1))
  end

  defp parse_row(line) do
    line
    |> String.trim()
    |> String.trim("|")
    |> String.split("|")
    |> Enum.map(&String.trim/1)
  end

  # -- Box-drawing "ASCII art" tables: ┌───┬───┐ / │ a │ b │ / └───┴───┘ -----
  # LLMs reach for these once they've learned Slack doesn't render markdown
  # pipe tables — still not a real table, so it gets the same treatment.

  @box_border_re ~r/^\s*[─┬┼┴┌┐├┤└┘]+\s*$/u
  @box_content_re ~r/^\s*│.+│\s*$/u

  defp box_border_line?(line), do: Regex.match?(@box_border_re, line)
  defp box_content_line?(line), do: Regex.match?(@box_content_re, line)

  defp take_box_table(lines) do
    {consumed, remaining} =
      Enum.split_while(lines, &(box_border_line?(&1) or box_content_line?(&1)))

    rows = consumed |> Enum.filter(&box_content_line?/1) |> Enum.map(&parse_box_row/1)
    {remaining, rows}
  end

  defp parse_box_row(line) do
    line
    |> String.trim()
    |> String.trim("│")
    |> String.split("│")
    |> Enum.map(&String.trim/1)
  end

  defp segment_to_blocks({:text, text}) do
    mrkdwn = from_markdown(text) |> String.slice(0, 2900)
    [%{"type" => "section", "text" => %{"type" => "mrkdwn", "text" => mrkdwn}}]
  end

  defp segment_to_blocks({:table, rows}) do
    rows =
      rows
      |> Enum.take(@max_table_rows)
      |> Enum.map(fn row -> row |> Enum.take(@max_table_cols) |> Enum.map(&table_cell/1) end)

    [%{"type" => "table", "rows" => rows}]
  end

  # `**bold**` inside a cell only renders if the cell is `rich_text` — plain
  # `raw_text` cells show the literal asterisks. Cells with no bold markers
  # stay `raw_text` (simpler, and that's the common case).
  @bold_cell_re ~r/\*\*(.+?)\*\*/

  defp table_cell(text) do
    if Regex.match?(@bold_cell_re, text) do
      %{
        "type" => "rich_text",
        "elements" => [
          %{"type" => "rich_text_section", "elements" => bold_segments(text)}
        ]
      }
    else
      %{"type" => "raw_text", "text" => text}
    end
  end

  defp bold_segments(text) do
    matches = Regex.scan(@bold_cell_re, text, return: :index)
    build_bold_segments(text, matches, 0)
  end

  defp build_bold_segments(text, [], pos) do
    rest = binary_part(text, pos, byte_size(text) - pos)
    if rest == "", do: [], else: [%{"type" => "text", "text" => rest}]
  end

  defp build_bold_segments(text, [[{start, len}, {cap_start, cap_len}] | rest_matches], pos) do
    before = binary_part(text, pos, start - pos)
    bold_text = binary_part(text, cap_start, cap_len)

    before_segment = if before == "", do: [], else: [%{"type" => "text", "text" => before}]
    bold_segment = %{"type" => "text", "text" => bold_text, "style" => %{"bold" => true}}

    before_segment ++ [bold_segment] ++ build_bold_segments(text, rest_matches, start + len)
  end

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
