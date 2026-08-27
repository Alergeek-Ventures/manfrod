defmodule Manfrod.LinearTest do
  use Manfrod.DataCase

  alias Manfrod.Linear

  @moduletag :db

  setup do
    Application.put_env(:manfrod, :linear_req_plug, {Req.Test, Manfrod.Linear.Client})
    on_exit(fn -> Application.delete_env(:manfrod, :linear_req_plug) end)
    :ok
  end

  defp stub_team(team_id \\ "team-1", team_name \\ "10BPS") do
    Req.Test.stub(Manfrod.Linear.Client, fn conn ->
      Req.Test.json(conn, %{
        "data" => %{
          "organization" => %{
            "teams" => %{"nodes" => [%{"id" => team_id, "name" => team_name}]}
          }
        }
      })
    end)
  end

  test "connect/3 persists an encrypted key that round-trips on read" do
    stub_team()
    project = insert_project!()
    user = insert_user!()

    assert {:ok, conn} = Linear.connect(project.id, user.id, "lin_api_secret")
    assert conn.status == "connected"
    assert conn.linear_team_id == "team-1"
    assert conn.linear_team_name == "10BPS"

    reloaded = Linear.get_connection(project.id)
    assert reloaded.api_key == "lin_api_secret"

    {:ok, %{rows: [[raw_bytes]]}} =
      Ecto.Adapters.SQL.query(
        Repo,
        "select api_key from project_linear_connections where project_id = $1",
        [Ecto.UUID.dump!(project.id)]
      )

    refute raw_bytes == "lin_api_secret"
  end

  test "connect/3 rejects an invalid key" do
    Req.Test.stub(Manfrod.Linear.Client, fn conn -> Plug.Conn.send_resp(conn, 401, "") end)
    project = insert_project!()
    user = insert_user!()

    assert {:error, :invalid_key} = Linear.connect(project.id, user.id, "bad_key")
    assert Linear.get_connection(project.id) == nil
  end

  test "disconnect/1 flips status and get_connection stops returning it" do
    stub_team()
    project = insert_project!()
    user = insert_user!()

    {:ok, _conn} = Linear.connect(project.id, user.id, "lin_api_secret")
    assert Linear.get_connection(project.id)

    assert {:ok, disconnected} = Linear.disconnect(project.id)
    assert disconnected.status == "disconnected"
    assert Linear.get_connection(project.id) == nil
  end

  test "get_connection/1 returns nil for an unknown project" do
    assert Linear.get_connection(Ecto.UUID.generate()) == nil
  end

  test "get_connection/1 returns nil for a project-less (company) channel" do
    assert Linear.get_connection(nil) == nil
  end
end
