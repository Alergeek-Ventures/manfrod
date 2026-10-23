defmodule Manfrod.Tools.Vacation do
  @moduledoc """
  Vacation/absence reporting tool for the live agent. Usage instructions live
  in the `vacation-tracking` skill (priv/skills/vacation-tracking/SKILL.md);
  this module only implements the tool itself.
  """

  alias Manfrod.Accounts
  alias Manfrod.Memory
  alias Manfrod.Memory.PendingOps
  alias Manfrod.Tools.Support
  alias Manfrod.Voyage

  def definitions(%{user_id: user_id, msg_ctx: msg_ctx}) do
    [
      ReqLLM.Tool.new!(
        name: "report_vacation",
        description:
          "Flag a planned absence from the office for the background memory to record: time off " <>
            "(vacation, day off, sick leave) or work away from the office (business trip, client " <>
            "visit, remote work from elsewhere). The memory saves it and decides on its own whether " <>
            "to propose sharing with all clients. Call whenever the user mentions being absent — do " <>
            "NOT ask the user about client visibility. When someone corrects an absence that is " <>
            "already recorded, call it again with the corrected dates and details: it replaces the old record. " <>
            "Never use it to record that an absence was called off — use cancel_vacation for that.",
        parameter_schema: [
          start_date: [type: :string, required: true, doc: "Start date ISO8601 (YYYY-MM-DD)"],
          end_date: [type: :string, required: true, doc: "End date ISO8601 (YYYY-MM-DD)"],
          working: [
            type: :boolean,
            required: false,
            doc:
              "true when the person keeps working, just not from the office (business trip, client visit, conference, remote work from elsewhere). Omit or false for time off."
          ],
          details: [
            type: :string,
            required: false,
            doc:
              "What it is, in Polish, with names spelled exactly as the person wrote them, e.g. 'wyjazd do klienta Scape w Sztokholmie', 'L4', 'urlop w Grecji'."
          ]
        ],
        callback: fn args -> report_vacation(user_id, msg_ctx, args) end
      ),
      ReqLLM.Tool.new!(
        name: "cancel_vacation",
        description:
          "Delete the user's own recorded absence when they call it off entirely (they will be in the " <>
            "office after all, the trip is cancelled). Removes every absence of theirs overlapping the " <>
            "given dates. When only the dates or details change, use report_vacation instead.",
        parameter_schema: [
          start_date: [
            type: :string,
            required: true,
            doc: "First day of the cancelled absence, ISO8601 (YYYY-MM-DD)"
          ],
          end_date: [
            type: :string,
            required: false,
            doc: "Last day of the cancelled absence, ISO8601 (YYYY-MM-DD). Omit for a single day."
          ]
        ],
        callback: fn args -> cancel_vacation(user_id, msg_ctx, args) end
      )
    ]
  end

  defp report_vacation(user_id, msg_ctx, %{start_date: start_date, end_date: end_date} = args) do
    working = Map.get(args, :working) == true
    note = absence_note(user_id, start_date, end_date, working, Map.get(args, :details))

    case Support.flaggable(msg_ctx) do
      {:ok, channel_id, ts} ->
        PendingOps.flag_message(channel_id, ts, "create_absence", %{
          start_date: start_date,
          end_date: end_date,
          content: note,
          working: working
        })

        {:ok,
         "Zanotowane (#{start_date}..#{end_date}). Pamięć w tle zapisze nieobecność i w razie potrzeby zapyta o udostępnienie klientom."}

      :error ->
        report_vacation_direct(user_id, start_date, end_date, note)
    end
  end

  defp report_vacation_direct(user_id, start_date, end_date, note) do
    access = ["internal", "external/all"]

    with {:ok, fact, _outcome} <-
           Manfrod.Facts.put_absence(user_id, start_date, end_date, note, access),
         {:ok, embedding} <- Voyage.embed_query(note),
         {:ok, _node} <-
           Memory.create_node(user_id, fact.access, %{content: note, embedding: embedding}) do
      {:ok, "Zapisałem nieobecność: #{fact.value}"}
    else
      {:error, %Ecto.Changeset{} = changeset} ->
        {:ok, "Błąd zapisu: #{inspect(changeset.errors)}"}

      {:error, e} ->
        {:ok, "Błąd zapisu: #{inspect(e)}"}
    end
  end

  defp cancel_vacation(user_id, msg_ctx, %{start_date: start_date} = args) do
    end_date = Map.get(args, :end_date) || start_date

    case Manfrod.Facts.delete_absences(user_id, start_date, end_date) do
      [] ->
        {:ok, "Brak zapisanej nieobecności w #{start_date}..#{end_date}, nic nie usunięto."}

      deleted ->
        values = Enum.map_join(deleted, "; ", & &1.value)
        note = "#{user_name(user_id)} odwołuje nieobecność, jest już nieaktualna: #{values}"
        record_cancellation(user_id, msg_ctx, note, deleted)
        {:ok, "Usunięto nieobecność: #{values}"}
    end
  end

  defp record_cancellation(user_id, msg_ctx, note, deleted) do
    case Support.flaggable(msg_ctx) do
      {:ok, channel_id, ts} ->
        PendingOps.flag_message(channel_id, ts, "create_memory", %{content: note})

      :error ->
        access = deleted |> Enum.flat_map(& &1.access) |> Enum.uniq()

        with {:ok, embedding} <- Voyage.embed_query(note) do
          Memory.create_node(user_id, access, %{content: note, embedding: embedding})
        end
    end
  end

  defp absence_note(user_id, start_date, end_date, working, details) do
    dates = if start_date == end_date, do: start_date, else: "#{start_date}..#{end_date}"
    name = user_name(user_id)

    case {working, blank_to_nil(details)} do
      {true, nil} -> "#{name} pracuje poza biurem #{dates}"
      {true, details} -> "#{name} pracuje poza biurem #{dates}: #{details}"
      {false, nil} -> "#{name} bierze urlop #{dates}"
      {false, details} -> "#{name} nie będzie w biurze #{dates}: #{details}"
    end
  end

  defp blank_to_nil(value) when is_binary(value) do
    if String.trim(value) == "", do: nil, else: String.trim(value)
  end

  defp blank_to_nil(_value), do: nil

  defp user_name(user_id) do
    case Accounts.get_user(user_id) do
      %{name: name} when is_binary(name) and name != "" -> name
      _ -> "User"
    end
  end
end
