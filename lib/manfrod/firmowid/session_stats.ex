defmodule Manfrod.Firmowid.SessionStats do
  @moduledoc """
  Shared helpers for the Firmowid reminder schedulers —
  `Manfrod.Workers.FirmowidReminderSchedulerWorker` (end-of-day) and
  `Manfrod.Workers.FirmowidMorningReminderSchedulerWorker` (start-of-day):
  fetching a user's recent sessions and averaging what time of day they
  start or end, per calendar day. A workday usually has several sessions
  (meetings, breaks resuming later), so averaging every single one instead
  of just the day's first/last skews the result — verified against live
  session data for the end-of-day case.

  Also used by the morning check itself to see whether a session is
  already running, without going through the LLM for that part.
  """

  alias Manfrod.Mcp.Client

  @timezone "Europe/Warsaw"

  @doc "Fetch a user's most recent `limit` sessions, newest first."
  @spec fetch_recent_sessions(String.t(), String.t(), pos_integer()) ::
          {:ok, [map()]} | {:error, term()}
  def fetch_recent_sessions(mcp_url, access_token, limit) do
    case Client.call_tool(mcp_url, access_token, "list_sessions", %{
           "input" => %{},
           "limit" => limit,
           "sort" => [%{"field" => "start_datetime", "direction" => "desc"}]
         }) do
      {:ok, result} -> {:ok, extract_records(result)}
      {:error, reason} -> {:error, reason}
    end
  end

  @doc "Whether the user currently has an active (unfinished) Firmowid session."
  @spec active_session?(String.t(), String.t()) :: {:ok, boolean()} | {:error, term()}
  def active_session?(mcp_url, access_token) do
    case Client.call_tool(mcp_url, access_token, "get_current_session", %{}) do
      {:ok, result} -> {:ok, extract_records(result) != []}
      {:error, reason} -> {:error, reason}
    end
  end

  @doc """
  Average time-of-day of each calendar day's first (`:min`) or last (`:max`)
  session, reading `field` (`"start_datetime"` or `"end_datetime"`). `today`
  is always excluded — a day still in progress isn't representative of its
  eventual start/end. Returns `{:ok, %Time{}}`, or `:error` if there's no
  usable data.
  """
  @spec average_time_of_day([map()], Date.t(), String.t(), :min | :max) ::
          {:ok, Time.t()} | :error
  def average_time_of_day(sessions, today, field, agg) do
    seconds =
      sessions
      |> Enum.map(&Map.get(&1, field))
      |> Enum.reject(&is_nil/1)
      |> Enum.map(&local_datetime/1)
      |> Enum.reject(&is_nil/1)
      |> Enum.reject(&(DateTime.to_date(&1) == today))
      |> Enum.group_by(&DateTime.to_date/1)
      |> Enum.map(fn {_date, datetimes} -> pick(datetimes, agg) end)
      |> Enum.map(&seconds_of_day/1)

    case seconds do
      [] -> :error
      list -> {:ok, Time.add(~T[00:00:00], round(Enum.sum(list) / length(list)), :second)}
    end
  end

  defp pick(datetimes, :min), do: Enum.min_by(datetimes, &DateTime.to_unix/1)
  defp pick(datetimes, :max), do: Enum.max_by(datetimes, &DateTime.to_unix/1)

  defp extract_records(%{"structuredContent" => %{"records" => records}})
       when is_list(records),
       do: records

  defp extract_records(%{"structuredContent" => records}) when is_list(records), do: records

  defp extract_records(%{"content" => content}) when is_list(content) do
    text =
      content
      |> Enum.map(fn
        %{"type" => "text", "text" => text} -> text
        _ -> nil
      end)
      |> Enum.reject(&is_nil/1)
      |> Enum.join("\n")

    case Jason.decode(text) do
      {:ok, list} when is_list(list) -> list
      {:ok, %{"records" => list}} when is_list(list) -> list
      _ -> []
    end
  end

  defp extract_records(_), do: []

  defp local_datetime(iso_string) do
    case DateTime.from_iso8601(iso_string) do
      {:ok, dt, _offset} -> DateTime.shift_zone!(dt, @timezone)
      {:error, _} -> nil
    end
  end

  defp seconds_of_day(%DateTime{} = local) do
    local.hour * 3600 + local.minute * 60 + local.second
  end
end
