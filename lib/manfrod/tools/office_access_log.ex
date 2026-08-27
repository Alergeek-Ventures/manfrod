defmodule Manfrod.Tools.OfficeAccessLog do
  @moduledoc """
  Reads the office door's access log (who badged/keyed in and when), via
  `Manfrod.Kalafiornia.list_office_access_log/1`. Separate from
  `Manfrod.Tools.Kalafiornia` (which only opens the door for the caller) —
  this is a static-API-key log read, not a per-user session action.

  Meant as a building block for a later check ("did this person enter the
  office without starting a Firmowid session?") — for now it's just a
  read/filter tool.
  """

  alias Manfrod.Kalafiornia

  @timezone "Europe/Warsaw"

  def definitions(_ctx) do
    [
      ReqLLM.Tool.new!(
        name: "list_office_access_log",
        description:
          "List office door access events (who opened it, when, with app or key). " <>
            "Defaults to today. Use user_name to check a specific person.",
        parameter_schema: [
          since: [
            type: :string,
            required: false,
            doc: "Only entries from this date onward, ISO8601 (YYYY-MM-DD). Defaults to today."
          ],
          user_name: [
            type: :string,
            required: false,
            doc: "Case-insensitive substring filter on the person's name"
          ]
        ],
        callback: fn args -> list_office_access_log(args) end
      )
    ]
  end

  defp list_office_access_log(args) do
    with {:ok, since} <- parse_since(Map.get(args, :since)) do
      opts = [since: since, user_name: normalize_blank(Map.get(args, :user_name))]

      case Kalafiornia.list_office_access_log(opts) do
        {:ok, entries} -> {:ok, format_entries(entries)}
        {:error, reason} -> {:ok, "Nie udało się pobrać logu wejść: #{inspect(reason)}"}
      end
    else
      {:error, :invalid_date} -> {:ok, "Nieprawidłowa data w 'since', oczekiwano YYYY-MM-DD."}
    end
  end

  defp parse_since(nil), do: {:ok, Date.utc_today()}

  defp parse_since(date_str) do
    case Date.from_iso8601(date_str) do
      {:ok, date} -> {:ok, date}
      {:error, _} -> {:error, :invalid_date}
    end
  end

  defp normalize_blank(nil), do: nil
  defp normalize_blank(""), do: nil
  defp normalize_blank(value), do: value

  defp format_entries([]), do: "Brak wejść w tym okresie."

  defp format_entries(entries) do
    entries
    |> Enum.map(fn entry ->
      time =
        entry.time
        |> DateTime.shift_zone!(@timezone)
        |> Calendar.strftime("%Y-%m-%d %H:%M")

      "[#{time}] #{entry.user_name} (#{entry.opened_by})"
    end)
    |> Enum.join("\n")
  end
end
