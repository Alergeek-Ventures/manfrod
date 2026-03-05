defmodule Manfrod.Google.Calendar do
  @moduledoc """
  Google Calendar API client.

  Thin wrapper over the Calendar v3 REST API. Uses `Req` for HTTP and
  expects a valid OAuth access token (see `Manfrod.Google.Auth`).
  """

  @base_url "https://www.googleapis.com/calendar/v3"

  @doc """
  List events from the user's primary calendar.

  ## Options

    * `:time_min` — lower bound (DateTime, required)
    * `:time_max` — upper bound (DateTime, required)
    * `:max_results` — max events to return (default 250)

  Returns `{:ok, [event]}` where each event is a map with:

    * `:summary` — event title
    * `:start` — start time as ISO 8601 string (or date for all-day)
    * `:end` — end time as ISO 8601 string (or date for all-day)
    * `:location` — location string or nil
    * `:link` — htmlLink to the event in Google Calendar
    * `:attendees` — list of `%{email, name, status}` maps
    * `:all_day` — boolean, true for all-day events

  Or `{:error, reason}` on failure.
  """
  def list_events(access_token, opts) do
    time_min = Keyword.fetch!(opts, :time_min)
    time_max = Keyword.fetch!(opts, :time_max)
    max_results = Keyword.get(opts, :max_results, 250)

    params = [
      timeMin: DateTime.to_iso8601(time_min),
      timeMax: DateTime.to_iso8601(time_max),
      singleEvents: true,
      orderBy: "startTime",
      maxResults: max_results
    ]

    case Req.get("#{@base_url}/calendars/primary/events",
           params: params,
           headers: [{"authorization", "Bearer #{access_token}"}]
         ) do
      {:ok, %Req.Response{status: 200, body: body}} ->
        events =
          (body["items"] || [])
          |> Enum.reject(&(&1["status"] == "cancelled"))
          |> Enum.map(&normalize_event/1)

        {:ok, events}

      {:ok, %Req.Response{status: status, body: body}} ->
        {:error, {:api_error, status, body}}

      {:error, reason} ->
        {:error, {:http_error, reason}}
    end
  end

  defp normalize_event(raw) do
    {start_time, all_day} = parse_event_time(raw["start"])
    {end_time, _} = parse_event_time(raw["end"])

    attendees =
      (raw["attendees"] || [])
      |> Enum.reject(&(&1["self"] == true))
      |> Enum.map(fn a ->
        %{
          email: a["email"],
          name: a["displayName"],
          status: a["responseStatus"]
        }
      end)

    %{
      summary: raw["summary"] || "(no title)",
      start: start_time,
      end: end_time,
      all_day: all_day,
      location: raw["location"],
      link: raw["htmlLink"],
      attendees: attendees
    }
  end

  defp parse_event_time(nil), do: {nil, false}

  defp parse_event_time(%{"dateTime" => dt}) when is_binary(dt), do: {dt, false}

  defp parse_event_time(%{"date" => d}) when is_binary(d), do: {d, true}

  defp parse_event_time(_), do: {nil, false}
end
