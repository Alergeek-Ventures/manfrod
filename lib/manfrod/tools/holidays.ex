defmodule Manfrod.Tools.Holidays do
  @moduledoc """
  Public-holiday lookups plus per-user holiday-planning state, for the
  `holiday-check` cron skill (priv/skills/holiday-check/SKILL.md) and the
  live-agent DM replies it triggers via `ask_user_about_holiday`.

  Vacation itself is still recorded through the existing `report_vacation`
  tool (Manfrod.Tools.Vacation) — this module only adds the "are you working
  or unsure" branches vacation-tracking doesn't cover, plus the holiday feed
  and per-user resolution check the cron skill needs to decide who to ask.
  """

  alias Manfrod.{Accounts, Facts}
  alias Manfrod.Google

  @default_days 7
  @default_snooze_days 2

  def definitions(%{user_id: user_id, readable_levels: readable_levels}) do
    [
      ReqLLM.Tool.new!(
        name: "list_upcoming_holidays",
        description:
          "List public holidays coming up in the next N days from the configured country's " <>
            "holiday calendar. Use to find out what's coming, not to check any one user's plans.",
        parameter_schema: [
          days: [type: :integer, doc: "How many days ahead to look (default 7)"]
        ],
        callback: fn args -> list_upcoming_holidays(args) end
      ),
      ReqLLM.Tool.new!(
        name: "list_team_members",
        description: "List everyone Manfrod knows about (id + name) — for holiday-check fan-out.",
        parameter_schema: [],
        callback: fn _args -> list_team_members() end
      ),
      ReqLLM.Tool.new!(
        name: "check_holiday_plan",
        description:
          "Check whether a specific user already has a resolved plan for a given date: an " <>
            "absence/vacation covering it, a confirmed 'working' answer, or a not-yet-expired " <>
            "'unsure' snooze. Returns whether they still need to be asked. Call this before " <>
            "ask_user_about_holiday so you don't nag someone who already answered.",
        parameter_schema: [
          user_id: [type: :string, required: true, doc: "User UUID to check"],
          date: [type: :string, required: true, doc: "Date ISO8601 (YYYY-MM-DD)"]
        ],
        callback: fn args -> check_holiday_plan(readable_levels, args) end
      ),
      ReqLLM.Tool.new!(
        name: "ask_user_about_holiday",
        description:
          "Proactively DM a specific user asking whether they're working or taking vacation on " <>
            "an upcoming holiday. Safe to call directly — it re-checks the plan itself and is a " <>
            "no-op if already resolved/snoozed — but prefer check_holiday_plan first when " <>
            "fanning out over a whole team, so you don't waste calls.",
        parameter_schema: [
          user_id: [type: :string, required: true, doc: "User UUID to ask"],
          date: [type: :string, required: true, doc: "Holiday date ISO8601 (YYYY-MM-DD)"],
          holiday_name: [type: :string, required: true, doc: "Holiday name, e.g. 'Boże Ciało'"]
        ],
        callback: fn args -> ask_user_about_holiday(readable_levels, args) end
      ),
      ReqLLM.Tool.new!(
        name: "record_holiday_plan",
        description:
          "Record the current user's plan for an upcoming holiday: 'working' (working as normal " <>
            "that day) or 'unsure' (they'll decide later — you'll check back in a couple of days). " <>
            "For vacation, call report_vacation instead, not this.",
        parameter_schema: [
          date: [type: :string, required: true, doc: "Holiday date ISO8601 (YYYY-MM-DD)"],
          status: [type: :string, required: true, doc: "'working' or 'unsure'"],
          recheck_in_days: [
            type: :integer,
            doc: "Only for status 'unsure': days to wait before asking again (default 2)"
          ]
        ],
        callback: fn args -> record_holiday_plan(user_id, args) end
      )
    ]
  end

  defp list_upcoming_holidays(args) do
    days = Map.get(args, :days) || Map.get(args, "days") || @default_days
    calendar_id = Application.get_env(:manfrod, :holiday_calendar_id)

    today = Date.utc_today()
    time_min = DateTime.new!(today, ~T[00:00:00], "Etc/UTC")
    time_max = DateTime.new!(Date.add(today, days), ~T[00:00:00], "Etc/UTC")

    case Google.Calendar.list_holiday_events(calendar_id, time_min: time_min, time_max: time_max) do
      {:ok, []} ->
        {:ok, "No public holidays in the next #{days} day(s)."}

      {:ok, events} ->
        lines = Enum.map(events, fn e -> "- #{e.start}: #{e.summary}" end)
        {:ok, Enum.join(lines, "\n")}

      {:error, :no_google_api_key} ->
        {:ok, "ERROR: GOOGLE_API_KEY is not configured — can't read the public holiday calendar."}

      {:error, reason} ->
        {:ok, "Failed to fetch holidays: #{inspect(reason)}"}
    end
  end

  defp list_team_members do
    members =
      Accounts.list_users()
      |> Enum.reject(&String.starts_with?(&1.slack_id || "", "system:"))
      |> Enum.map(fn u -> "- #{u.id}: #{u.name || u.email}" end)

    if members == [] do
      {:ok, "No team members found."}
    else
      {:ok, Enum.join(members, "\n")}
    end
  end

  defp check_holiday_plan(readable_levels, %{user_id: user_id, date: date}) do
    case Date.from_iso8601(date) do
      {:ok, target} -> {:ok, holiday_plan_status(readable_levels, user_id, date, target)}
      {:error, _} -> {:ok, "Invalid date: #{date}"}
    end
  end

  defp holiday_plan_status(readable_levels, user_id, date, target) do
    case absence_covering(readable_levels, user_id, target) do
      {:covered, value} ->
        "resolved — already has an absence/vacation covering this date: #{value}"

      :not_covered ->
        recorded_plan_status(readable_levels, user_id, date)
    end
  end

  defp absence_covering(readable_levels, user_id, target) do
    (Facts.list_facts_by_user("absence:", user_id, readable_levels) ++
       Facts.list_facts_by_user("vacation:", user_id, readable_levels))
    |> Enum.find_value(:not_covered, fn fact ->
      with {:ok, from, to} <- date_range(fact.value),
           true <- Date.compare(target, from) != :lt and Date.compare(target, to) != :gt do
        {:covered, fact.value}
      else
        _ -> false
      end
    end)
  end

  defp date_range(value) do
    case Regex.run(~r/^(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})/, value) do
      [_, from_s, to_s] ->
        with {:ok, from} <- Date.from_iso8601(from_s),
             {:ok, to} <- Date.from_iso8601(to_s) do
          {:ok, from, to}
        else
          _ -> :error
        end

      _ ->
        :error
    end
  end

  defp recorded_plan_status(readable_levels, user_id, date) do
    key = "holiday-plan:#{user_id}:#{date}"

    case Facts.get_fact(key, readable_levels) do
      nil ->
        "needs_ask — no plan recorded for this date yet."

      %{value: "working"} ->
        "resolved — user already confirmed they're working that day."

      %{value: "unsure:" <> recheck_date} ->
        snoozed_status(recheck_date)

      %{value: other} ->
        "resolved — recorded plan: #{other}"
    end
  end

  defp snoozed_status(recheck_date) do
    case Date.from_iso8601(recheck_date) do
      {:ok, recheck} ->
        if Date.compare(Date.utc_today(), recheck) == :lt do
          "snoozed — user was unsure, don't ask again until #{recheck_date}."
        else
          "needs_ask — earlier 'unsure' snooze expired (was until #{recheck_date})."
        end

      {:error, _reason} ->
        "needs_ask — malformed snooze fact, treat as unresolved."
    end
  end

  defp ask_user_about_holiday(readable_levels, %{
         user_id: user_id,
         date: date,
         holiday_name: holiday_name
       }) do
    case Date.from_iso8601(date) do
      {:ok, target} ->
        case holiday_plan_status(readable_levels, user_id, date, target) do
          "needs_ask" <> _ -> send_holiday_question(user_id, date, holiday_name)
          status -> {:ok, "Pomijam #{user_id} na #{date} — już rozwiązane: #{status}"}
        end

      {:error, _} ->
        {:ok, "Invalid date: #{date}"}
    end
  end

  defp send_holiday_question(user_id, date, holiday_name) do
    prompt = """
    [Proaktywne sprawdzenie święta]
    Za mniej niż tydzień jest #{holiday_name} (#{date}). Nie masz nic zapisanego na ten dzień —
    ani urlopu, ani informacji że pracujesz. Zapytaj krótko, czy w tym dniu pracujesz, czy
    bierzesz urlop.

    Gdy user odpowie:
    - że pracuje → wywołaj record_holiday_plan(date: "#{date}", status: "working")
    - że bierze urlop / będzie nieobecny → wywołaj report_vacation jak zwykle (nie record_holiday_plan)
    - że jeszcze nie wie → wywołaj record_holiday_plan(date: "#{date}", status: "unsure"); zapytasz
      go ponownie za 2-3 dni
    """

    case Manfrod.Proactive.send(user_id, prompt) do
      :ok ->
        {:ok, "Wysłano pytanie do usera #{user_id} o #{holiday_name} (#{date})."}

      {:error, reason} ->
        {:ok, "Nie udało się wysłać pytania do #{user_id}: #{inspect(reason)}"}
    end
  end

  defp record_holiday_plan(user_id, %{date: date, status: "working"}) do
    write_plan_fact(user_id, date, "working", "Zanotowane — pracujesz #{date}.")
  end

  defp record_holiday_plan(user_id, %{date: date, status: "unsure"} = args) do
    recheck_in =
      Map.get(args, :recheck_in_days) || Map.get(args, "recheck_in_days") || @default_snooze_days

    recheck_date = Date.utc_today() |> Date.add(recheck_in) |> Date.to_iso8601()

    write_plan_fact(
      user_id,
      date,
      "unsure:#{recheck_date}",
      "Zanotowane — wrócę z pytaniem o #{date} za #{recheck_in} dni (#{recheck_date})."
    )
  end

  defp record_holiday_plan(_user_id, %{status: other}) do
    {:ok,
     "Nieznany status: #{other}. Użyj 'working' albo 'unsure' (dla urlopu użyj report_vacation)."}
  end

  defp write_plan_fact(user_id, date, value, success_message) do
    key = "holiday-plan:#{user_id}:#{date}"

    case Facts.set_fact(key, value, ["internal"], user_id) do
      {:ok, _fact} -> {:ok, success_message}
      {:error, changeset} -> {:ok, "Błąd zapisu: #{inspect(changeset.errors)}"}
    end
  end
end
