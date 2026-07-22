defmodule Manfrod.SkillRunner do
  @moduledoc """
  Runs a cron-skill autonomously: loads its SKILL.md body as instructions
  and lets the normal agent tool set (`Manfrod.Tools`) act on them in a
  loop — exactly as if a user had typed those instructions themselves. No
  per-skill Elixir code required; adding a new scheduled behavior is just a
  new `priv/skills/<name>/SKILL.md` with `cron` and `channel` fields.

  Scheduled by `Manfrod.Workers.SkillSchedulerWorker`, executed via
  `Manfrod.Workers.SkillTriggerWorker`, which calls `run/1` for every
  cron-skill regardless of name.
  """

  require Logger

  alias Manfrod.Accounts.User
  alias Manfrod.Slack.{API, Mrkdwn}
  alias Manfrod.{LLM, Repo, Skills, Tools}

  @timezone "Europe/Warsaw"
  @max_iterations 25

  @doc """
  Run the named cron-skill: build a fresh agent turn from its SKILL.md body
  and execute it to completion, posting tool-driven side effects and the
  final reply to the skill's configured channel.
  """
  @spec run(String.t()) :: :ok | {:error, term()}
  def run(skill_name) do
    with {:ok, skill} <- Skills.get(skill_name),
         {:ok, channel} <- require_channel(skill) do
      ctx = %{
        user_id: system_user_id(),
        readable_levels: ["internal"],
        write_access: ["internal"],
        msg_ctx: %{channel: channel, ts: nil}
      }

      messages = [
        ReqLLM.Context.system(system_prompt(ctx)),
        ReqLLM.Context.user(skill.body)
      ]

      case run_loop(ctx, messages, 0) do
        {:ok, final_text} ->
          post_final_text(channel, final_text)
          Logger.info("SkillRunner: '#{skill_name}' completed")
          :ok

        {:error, reason} = err ->
          Logger.error("SkillRunner: '#{skill_name}' failed: #{inspect(reason)}")
          err
      end
    else
      {:error, reason} ->
        Logger.error("SkillRunner: cannot run '#{skill_name}': #{inspect(reason)}")
        {:error, reason}
    end
  end

  defp require_channel(%{channel: channel}) when is_binary(channel) and channel != "" do
    {:ok, channel}
  end

  defp require_channel(skill) do
    {:error, {:missing_channel, skill.name}}
  end

  defp system_prompt(ctx) do
    now = DateTime.utc_now() |> DateTime.shift_zone!(@timezone)

    """
    You're running autonomously on a schedule — no one is watching this
    conversation live, so don't narrate or ask questions, just act. Follow
    the instructions in the next message using your tools. When you're
    done, reply with a short confirmation (1 sentence) — it gets posted to
    the target Slack channel exactly like a normal reply.

    [Current Context]
    Now: #{DateTime.to_iso8601(now)} (#{Calendar.strftime(now, "%A")})
    Timezone: #{@timezone}

    ## Your Capabilities
    #{Tools.capabilities_text(ctx)}
    """
  end

  defp run_loop(_ctx, _messages, iteration) when iteration > @max_iterations do
    {:error, :max_iterations}
  end

  defp run_loop(ctx, messages, iteration) do
    case LLM.generate_text(messages, tools: Tools.definitions(ctx), purpose: :skill_runner) do
      {:ok, response} ->
        case ReqLLM.Response.finish_reason(response) do
          :tool_calls -> run_tool_calls(ctx, messages, response, iteration)
          _other -> {:ok, ReqLLM.Response.text(response) || ""}
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp run_tool_calls(ctx, messages, response, iteration) do
    tool_calls = ReqLLM.Response.tool_calls(response)
    narrative = ReqLLM.Response.text(response) || ""
    assistant_msg = ReqLLM.Context.assistant(narrative, tool_calls: tool_calls)

    messages_with_results =
      Enum.reduce(tool_calls, messages ++ [assistant_msg], fn tool_call, msgs ->
        result = execute_tool(ctx, tool_call)
        msgs ++ [ReqLLM.Context.tool_result(tool_call.id, tool_call.function.name, result)]
      end)

    run_loop(ctx, messages_with_results, iteration + 1)
  end

  defp execute_tool(ctx, tool_call) do
    with {:ok, args} <- Jason.decode(tool_call.function.arguments),
         tool when not is_nil(tool) <-
           Enum.find(Tools.definitions(ctx), &(&1.name == tool_call.function.name)),
         {:ok, result} <- ReqLLM.Tool.execute(tool, args) do
      result
    else
      nil -> "Unknown tool: #{tool_call.function.name}"
      {:error, reason} -> "Tool error: #{inspect(reason)}"
    end
  end

  defp post_final_text(_channel, ""), do: :ok

  defp post_final_text(channel, text) do
    bot_token = Application.get_env(:manfrod, :slack_bot_token)
    API.post("chat.postMessage", bot_token, %{channel: channel, text: Mrkdwn.from_markdown(text)})
  end

  # Lazily creates a shared system identity for every cron-skill run, same
  # pattern as Manfrod.Memory.Retrospector's system_user_id/0.
  defp system_user_id do
    slack_id = "system:skill-runner"

    case Repo.get_by(User, slack_id: slack_id) do
      nil ->
        {:ok, user} =
          %User{}
          |> User.changeset(%{
            slack_id: slack_id,
            slack_dm_channel_id: slack_id,
            name: "Skill Runner",
            email: "skill-runner@system.manfrod"
          })
          |> Repo.insert()

        user.id

      user ->
        user.id
    end
  end
end
