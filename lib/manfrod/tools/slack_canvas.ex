defmodule Manfrod.Tools.SlackCanvas do
  @moduledoc """
  Read-only access to Slack canvases: the document-like pages channels can
  pin (the channel's Canvas tab) or share as standalone files. Complements
  `Manfrod.Tools.SlackRead` (messages/threads) by covering the other kind of
  content a channel can hold.

  Requires the bot token to have `canvases:read`, `channels:read` and
  `files:read` scopes.
  """

  alias Manfrod.Slack.API

  def definitions(_ctx) do
    [
      ReqLLM.Tool.new!(
        name: "list_slack_canvases",
        description:
          "List canvases (document-like pages) attached to a Slack channel, including its pinned channel canvas if it has one. Use before read_slack_canvas if you don't already know which canvas or file ID to read.",
        parameter_schema: [
          channel: [
            type: :string,
            required: true,
            doc: "Channel name (e.g. 'general' or '#general') or Slack channel ID"
          ]
        ],
        callback: fn args -> list_slack_canvases(args) end
      ),
      ReqLLM.Tool.new!(
        name: "read_slack_canvas",
        description:
          "Read the full markdown content of a Slack canvas. Give a channel to read that channel's pinned canvas, or a specific canvas/file ID (from list_slack_canvases) to read a particular one.",
        parameter_schema: [
          channel: [
            type: :string,
            required: false,
            doc: "Channel name or ID whose pinned canvas to read. Ignored if canvas_id is given."
          ],
          canvas_id: [
            type: :string,
            required: false,
            doc: "Specific canvas/file ID to read, e.g. from list_slack_canvases (e.g. 'F123ABC')"
          ]
        ],
        callback: fn args -> read_slack_canvas(args) end
      )
    ]
  end

  defp list_slack_canvases(args) do
    token = bot_token()

    with {:ok, channel_id} <- resolve_channel(Map.get(args, :channel)),
         {:ok, files} <- API.list_canvases(token, channel: channel_id) do
      channel_canvas_id =
        case API.get_channel_canvas_id(token, channel_id) do
          {:ok, id} -> id
          {:error, _} -> nil
        end

      format_canvas_list(files, channel_canvas_id)
    else
      {:error, :not_found} -> {:ok, "Nie znalazłem kanału: #{Map.get(args, :channel)}"}
      {:error, reason} -> {:ok, "Nie udało się pobrać listy canvasów: #{inspect(reason)}"}
    end
  end

  defp read_slack_canvas(%{canvas_id: canvas_id}) when is_binary(canvas_id) and canvas_id != "" do
    fetch_and_format(canvas_id)
  end

  defp read_slack_canvas(%{channel: channel}) when is_binary(channel) and channel != "" do
    token = bot_token()

    with {:ok, channel_id} <- resolve_channel(channel),
         {:ok, file_id} when is_binary(file_id) <- API.get_channel_canvas_id(token, channel_id) do
      fetch_and_format(file_id)
    else
      {:ok, nil} -> {:ok, "Ten kanał nie ma przypiętego canvasu."}
      {:error, :not_found} -> {:ok, "Nie znalazłem kanału: #{channel}"}
      {:error, reason} -> {:ok, "Nie udało się odczytać canvasu: #{inspect(reason)}"}
    end
  end

  defp read_slack_canvas(_args), do: {:ok, "Podaj channel lub canvas_id."}

  defp fetch_and_format(file_id) do
    token = bot_token()

    with {:ok, %{"url_private" => url}} <- API.get_file_info(token, file_id),
         {:ok, content} <- API.download_file(token, url) do
      {:ok, content}
    else
      {:error, reason} -> {:ok, "Nie udało się odczytać canvasu: #{inspect(reason)}"}
    end
  end

  defp format_canvas_list([], _channel_canvas_id), do: {:ok, "Brak canvasów w tym kanale."}

  defp format_canvas_list(files, channel_canvas_id) do
    lines =
      Enum.map(files, fn file ->
        id = Map.get(file, "id")
        title = Map.get(file, "title", "(bez tytułu)")
        marker = if id == channel_canvas_id, do: " [canvas kanału]", else: ""
        "#{id}: #{title}#{marker}"
      end)

    {:ok, Enum.join(lines, "\n")}
  end

  defp bot_token, do: Application.get_env(:manfrod, :slack_bot_token)

  defp resolve_channel(channel), do: API.resolve_channel(bot_token(), channel)
end
