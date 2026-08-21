defmodule Manfrod.Tools.LinearTest do
  use Manfrod.DataCase

  alias Manfrod.Linear
  alias Manfrod.Tools.Linear, as: LinearTool

  @moduletag :db

  defp run(name, msg_ctx, args) do
    tool =
      %{msg_ctx: msg_ctx}
      |> LinearTool.definitions()
      |> Enum.find(&(&1.name == name))

    ReqLLM.Tool.execute(tool, args)
  end

  test "definitions/1 returns [] for a channel with no project mapping" do
    assert LinearTool.definitions(%{msg_ctx: %{channel: "C_UNMAPPED"}}) == []
  end

  test "definitions/1 returns [] for a mapped project with no Linear connection" do
    project = insert_project!()
    mapping = insert_channel_mapping!(%{project_id: project.id})

    assert LinearTool.definitions(%{msg_ctx: %{channel: mapping.slack_channel_id}}) == []
  end

  test "definitions/1 returns [] once the connection is disconnected" do
    project = insert_project!()
    mapping = insert_channel_mapping!(%{project_id: project.id})
    user = insert_user!()

    stub_team()
    {:ok, _conn} = Linear.connect(project.id, user.id, "lin_api_secret")
    Linear.disconnect(project.id)

    assert LinearTool.definitions(%{msg_ctx: %{channel: mapping.slack_channel_id}}) == []
  end

  test "definitions/1 exposes tools once connected, and executes one" do
    project = insert_project!()
    mapping = insert_channel_mapping!(%{project_id: project.id})
    user = insert_user!()

    stub_team()
    {:ok, _conn} = Linear.connect(project.id, user.id, "lin_api_secret")

    msg_ctx = %{channel: mapping.slack_channel_id}
    tools = LinearTool.definitions(%{msg_ctx: msg_ctx})
    assert Enum.any?(tools, &(&1.name == "linear_list_issues"))

    Req.Test.stub(Manfrod.Linear.Client, fn conn ->
      Req.Test.json(conn, %{
        "data" => %{
          "issues" => %{
            "nodes" => [
              %{
                "identifier" => "ENG-1",
                "title" => "Fix bug",
                "state" => %{"name" => "Todo"},
                "assignee" => nil,
                "url" => "https://linear.app/x/issue/ENG-1"
              }
            ]
          }
        }
      })
    end)

    assert {:ok, result} = run("linear_list_issues", msg_ctx, %{})
    assert result =~ "ENG-1"
  end

  defp stub_team do
    Application.put_env(:manfrod, :linear_req_plug, {Req.Test, Manfrod.Linear.Client})
    on_exit(fn -> Application.delete_env(:manfrod, :linear_req_plug) end)

    Req.Test.stub(Manfrod.Linear.Client, fn conn ->
      Req.Test.json(conn, %{
        "data" => %{
          "organization" => %{
            "teams" => %{"nodes" => [%{"id" => "team-1", "name" => "10BPS"}]}
          }
        }
      })
    end)
  end
end
