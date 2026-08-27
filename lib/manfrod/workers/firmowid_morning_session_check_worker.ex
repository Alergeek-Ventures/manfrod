defmodule Manfrod.Workers.FirmowidMorningSessionCheckWorker do
  @moduledoc """
  Runs a single scheduled morning check for one user: did they open the
  office door today (`Manfrod.Kalafiornia.list_office_access_log/1`) but
  never start a Firmowid session? If so, hands off to
  `Manfrod.SkillRunner` (the "firmowid-morning-checkin" skill) to DM them
  asking what they're working on and start a session from their reply.

  The office-entry check happens here in plain Elixir, not via an LLM tool
  call, because there's no way for the LLM to know which office-log
  `userName` corresponds to "itself" — this worker already knows via
  `Manfrod.Accounts.get_user!/1`, so it only invokes the skill (and the DM
  it sends) when there's actually something to nudge about.

  Scheduled by `Manfrod.Workers.FirmowidMorningReminderSchedulerWorker` at
  a time computed from that user's own session history — deliberately a
  distinct worker from `Manfrod.Workers.SkillTriggerWorker` for the same
  reason as `Manfrod.Workers.FirmowidSessionCheckWorker`: those get swept
  on every deploy by `Manfrod.Release.reset_skill_schedule/0`.
  """
  use Oban.Worker,
    queue: :default,
    max_attempts: 3

  require Logger

  alias Manfrod.{Accounts, Kalafiornia, Mcp}
  alias Manfrod.Firmowid.SessionStats

  @provider "firmowid"
  @skill_name "firmowid-morning-checkin"

  @impl Oban.Worker
  def perform(%Oban.Job{args: %{"user_id" => user_id, "date" => date_iso}}) do
    date = Date.from_iso8601!(date_iso)

    with %Mcp.Connection{} = conn <- Mcp.get_connection(user_id, @provider),
         provider when not is_nil(provider) <-
           Enum.find(Mcp.builtin_providers(), &(&1.id == @provider)),
         {:ok, access_token} <- Mcp.ensure_valid_token(conn),
         {:ok, false} <- SessionStats.active_session?(provider.mcp_url, access_token),
         true <- entered_office?(user_id, date) do
      Manfrod.SkillRunner.run(@skill_name, user_id: user_id)
    else
      {:ok, true} ->
        :ok

      false ->
        :ok

      nil ->
        :ok

      {:error, reason} ->
        Logger.debug("FirmowidMorningSessionCheckWorker: skipping #{user_id}: #{inspect(reason)}")

        :ok
    end
  end

  defp entered_office?(user_id, date) do
    user = Accounts.get_user!(user_id)

    case Kalafiornia.list_office_access_log(since: date, user_name: user.name) do
      {:ok, entries} -> entries != []
      {:error, reason} -> {:error, reason}
    end
  end
end
