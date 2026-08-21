defmodule Manfrod.Linear.ClientTest do
  use ExUnit.Case, async: true

  alias Manfrod.Linear.Client

  setup do
    Application.put_env(:manfrod, :linear_req_plug, {Req.Test, __MODULE__})
    on_exit(fn -> Application.delete_env(:manfrod, :linear_req_plug) end)
    :ok
  end

  test "verify_key returns the single scoped team" do
    Req.Test.stub(__MODULE__, fn conn ->
      Req.Test.json(conn, %{
        "data" => %{
          "organization" => %{"teams" => %{"nodes" => [%{"id" => "team-1", "name" => "10BPS"}]}}
        }
      })
    end)

    assert {:ok, %{id: "team-1", name: "10BPS"}} = Client.verify_key("lin_api_test")
  end

  test "verify_key returns :unauthorized on a 401" do
    Req.Test.stub(__MODULE__, fn conn -> Plug.Conn.send_resp(conn, 401, "") end)

    assert {:error, :unauthorized} = Client.query("bad_key", "query { viewer { id } }")
  end

  test "list_issues parses the issue list" do
    Req.Test.stub(__MODULE__, fn conn ->
      Req.Test.json(conn, %{
        "data" => %{
          "issues" => %{
            "nodes" => [
              %{
                "identifier" => "ENG-1",
                "title" => "Fix bug",
                "state" => %{"name" => "Todo"},
                "assignee" => %{"name" => "Kamil"},
                "url" => "https://linear.app/x/issue/ENG-1"
              }
            ]
          }
        }
      })
    end)

    assert {:ok, [issue]} = Client.list_issues("lin_api_test", "team-1")
    assert issue["identifier"] == "ENG-1"
  end
end
