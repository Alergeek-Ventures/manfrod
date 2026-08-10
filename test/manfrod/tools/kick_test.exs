defmodule Manfrod.Tools.KickTest do
  use ExUnit.Case, async: true

  alias Manfrod.Tools.Kick

  defp tool(msg_ctx) do
    [definition] = Kick.definitions(%{msg_ctx: msg_ctx})
    definition
  end

  defp call(msg_ctx), do: ReqLLM.Tool.execute(tool(msg_ctx), %{})

  describe "leave_thread" do
    test "is offered with no parameters, so the model can't aim it elsewhere" do
      definition = tool(%{channel: "C1", thread_ts: "1.1", slack_user_id: "U1"})

      assert definition.name == "leave_thread"
      assert definition.parameter_schema == []
    end

    test "refuses outside a thread instead of pretending to leave" do
      assert {:ok, message} =
               call(%{channel: "D1", thread_ts: nil, slack_user_id: "U1"})

      assert message =~ "Not in a channel thread"
    end

    test "refuses when there is no Slack context at all" do
      assert {:ok, message} =
               call(%{channel: nil, ts: nil, thread_ts: nil, slack_user_id: nil})

      assert message =~ "Not in a channel thread"
    end
  end
end
