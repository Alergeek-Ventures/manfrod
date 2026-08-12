defmodule Manfrod.Tools.Kalafiornia do
  @moduledoc """
  Lets the agent open the office door via the Kalafiornia app, using the
  caller's own session (`Manfrod.Kalafiornia`), connected on the
  integrations page (/integrations).

  There's only one door, so `door_id` is fixed here rather than an LLM
  parameter — leaving it free-text just invited the model to invent
  values (`""`, `"main"`, ...) that Kalafiornia rejects with a 500.
  """

  alias Manfrod.Kalafiornia

  @door_id "studencka4-4"

  def definitions(%{user_id: user_id}) do
    [
      ReqLLM.Tool.new!(
        name: "open_office_door",
        description:
          "Opens the office door via the Kalafiornia app, using the caller's own connected " <>
            "Kalafiornia session. If they haven't connected it, returns an error asking them " <>
            "to log in at the web app's integrations page.",
        parameter_schema: [],
        callback: fn _args -> open_door(user_id) end
      )
    ]
  end

  defp open_door(user_id) do
    case Kalafiornia.open_door(user_id, @door_id) do
      {:ok, _body} ->
        {:ok, "Door opened."}

      {:error, :not_connected} ->
        {:ok,
         "ERROR: No Kalafiornia account connected. The user needs to log in at the web app's integrations page (/integrations)."}

      {:error, :session_invalid} ->
        {:ok,
         "ERROR: Kalafiornia session expired. The user needs to log in again at the web app's integrations page (/integrations)."}

      {:error, reason} ->
        {:ok, "Kalafiornia door open failed: #{inspect(reason)}"}
    end
  end
end
