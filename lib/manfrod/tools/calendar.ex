defmodule Manfrod.Tools.Calendar do
  @moduledoc """
  Google Calendar tool for the live agent.
  """

  alias Manfrod.Accounts
  alias Manfrod.Google

  def definitions(%{user_id: user_id}) do
    [
      ReqLLM.Tool.new!(
        name: "get_calendar_events",
        description:
          "Fetch events from the user's Google Calendar. Returns upcoming events for a given date range. " <>
            "If the user has no Google account linked, returns an error asking them to sign in via the web app.",
        parameter_schema: [
          date: [
            type: :string,
            doc:
              "Start date in ISO 8601 format (e.g., '2026-03-05'). Defaults to today if omitted."
          ],
          days: [
            type: :integer,
            doc: "Number of days to fetch from the start date (default: 1)"
          ]
        ],
        callback: fn args -> get_calendar_events(user_id, args) end
      )
    ]
  end

  defp get_calendar_events(user_id, args) do
    case Accounts.get_google_identity(user_id) do
      nil ->
        {:ok,
         "ERROR: No Google account linked. The user needs to sign in at the web app to connect their Google Calendar."}

      identity ->
        case Google.Auth.ensure_valid_token(identity) do
          {:ok, access_token} ->
            {time_min, time_max} = calendar_time_range(args)

            case Google.Calendar.list_events(access_token,
                   time_min: time_min,
                   time_max: time_max
                 ) do
              {:ok, []} ->
                {:ok,
                 "No events found for #{Date.to_iso8601(DateTime.to_date(time_min))} to #{Date.to_iso8601(DateTime.to_date(time_max))}."}

              {:ok, events} ->
                {:ok, format_calendar_events(events, time_min, time_max)}

              {:error, reason} ->
                {:ok, "Failed to fetch calendar events: #{inspect(reason)}"}
            end

          {:error, :no_refresh_token} ->
            {:ok,
             "ERROR: Google token expired and no refresh token available. The user needs to re-authenticate at the web app."}

          {:error, reason} ->
            {:ok, "Failed to refresh Google token: #{inspect(reason)}"}
        end
    end
  end

  defp calendar_time_range(args) do
    date_string = Map.get(args, :date) || Map.get(args, "date")
    days = Map.get(args, :days) || Map.get(args, "days") || 1

    start_date =
      case date_string do
        nil ->
          Date.utc_today()

        str ->
          case Date.from_iso8601(str) do
            {:ok, d} -> d
            _ -> Date.utc_today()
          end
      end

    time_min = DateTime.new!(start_date, ~T[00:00:00], "Etc/UTC")
    end_date = Date.add(start_date, days)
    time_max = DateTime.new!(end_date, ~T[00:00:00], "Etc/UTC")

    {time_min, time_max}
  end

  defp format_calendar_events(events, time_min, time_max) do
    header =
      "Calendar events from #{Date.to_iso8601(DateTime.to_date(time_min))} to #{Date.to_iso8601(DateTime.to_date(time_max))}:\n"

    lines =
      Enum.map(events, fn event ->
        time =
          if event.all_day do
            "All day (#{event.start})"
          else
            "#{event.start} — #{event.end}"
          end

        parts = ["• #{event.summary}", "  Time: #{time}"]

        parts =
          if event.location, do: parts ++ ["  Location: #{event.location}"], else: parts

        parts =
          if event.attendees != [] do
            names =
              Enum.map(event.attendees, fn a ->
                name = a.name || a.email
                "#{name} (#{a.status})"
              end)

            parts ++ ["  Attendees: #{Enum.join(names, ", ")}"]
          else
            parts
          end

        Enum.join(parts, "\n")
      end)

    header <> Enum.join(lines, "\n\n")
  end
end
