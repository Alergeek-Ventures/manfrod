defmodule Manfrod.Tools.VacationTest do
  use Manfrod.DataCase

  alias Manfrod.Tools.Vacation, as: VacationTool

  @moduletag :db
  @moduletag :external_api

  @no_channel %{channel: nil, ts: nil}

  defp run(name, user_id, args, msg_ctx \\ @no_channel) do
    tool =
      %{user_id: user_id, msg_ctx: msg_ctx}
      |> VacationTool.definitions()
      |> Enum.find(&(&1.name == name))

    ReqLLM.Tool.execute(tool, args)
  end

  describe "report_vacation (direct write, no Slack context)" do
    test "standardizes the note as '<name> bierze urlop <date>'" do
      user = insert_user!(%{name: "Ola Test"})

      assert {:ok, msg} =
               run("report_vacation", user.id, %{start_date: "2026-08-15", end_date: "2026-08-15"})

      assert msg =~ "Ola Test bierze urlop 2026-08-15"
    end

    test "uses a date range when start and end differ" do
      user = insert_user!(%{name: "Ola Test"})

      assert {:ok, msg} =
               run("report_vacation", user.id, %{
                 start_date: "2026-08-15",
                 end_date: "2026-08-16"
               })

      assert msg =~ "Ola Test bierze urlop 2026-08-15..2026-08-16"
    end
  end
end
