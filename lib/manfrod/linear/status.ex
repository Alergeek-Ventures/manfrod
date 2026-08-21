defmodule Manfrod.Linear.Status do
  @moduledoc """
  The `/linear-status` UI: an ephemeral connect/connected message with a
  button, a modal to paste the API key, and the DM that reports the result.

  Ephemeral rather than a channel post — this is a key-management flow, kept
  out of channel history. The key itself is only ever typed into a Slack
  modal, which is never persisted to any message history at all (Block
  Kit's `input`/`plain_text_input` elements only exist inside modals or the
  Home tab — not in regular or ephemeral messages).

  The original ephemeral message can't be edited via `chat.update` (it has
  no `ts` the Web API accepts) — instead, every button click carries a
  `response_url` that can replace that exact message. It's threaded through
  the modal's `private_metadata` (as JSON, alongside `project_id`) so the
  connect flow can refresh the message it started from once the key is
  verified, not just DM the result.
  """

  require Logger

  alias Manfrod.Linear
  alias Manfrod.Memory.Project
  alias Manfrod.Slack.API

  @callback_id "linear_connect_modal"

  @doc "Posts the ephemeral connect/connected status for `project` into `channel_id`, visible only to `slack_user_id`."
  @spec post_status(String.t(), String.t(), String.t(), Project.t()) :: :ok
  def post_status(bot_token, channel_id, slack_user_id, %Project{} = project) do
    {text, blocks} = render(project)

    API.post("chat.postEphemeral", bot_token, %{
      channel: channel_id,
      user: slack_user_id,
      text: text,
      blocks: blocks
    })

    :ok
  end

  @doc "Replaces the message behind `response_url` with `project`'s current status."
  @spec refresh(String.t() | nil, Project.t()) :: :ok
  def refresh(nil, _project), do: :ok

  def refresh(response_url, %Project{} = project) do
    {text, blocks} = render(project)
    API.respond(response_url, %{replace_original: true, text: text, blocks: blocks})
    :ok
  end

  defp render(project) do
    case Linear.get_connection(project.id) do
      nil ->
        text = disconnected_text(project)
        {text, status_blocks(text, connect_button(project.id))}

      conn ->
        text = connected_text(conn)
        {text, status_blocks(text, disconnect_button(project.id))}
    end
  end

  defp status_blocks(text, action_block) do
    [%{type: "section", text: %{type: "mrkdwn", text: text}}, action_block]
  end

  defp disconnected_text(project) do
    "🔴 *Linear nie jest połączony* dla projektu `#{project.slug}`.\n\n" <>
      "Żeby połączyć:\n" <>
      "1. W Linearze: *Settings → API → Personal API keys → New API key*\n" <>
      "2. *Permissions* → \"Only select permissions...\" → zaznacz tylko *Read*\n" <>
      "3. *Team access* → \"Only select teams...\" → wybierz zespół odpowiadający projektowi `#{project.slug}`\n" <>
      "4. Utwórz klucz i skopiuj go\n" <>
      "5. Kliknij *Connect* poniżej i wklej klucz"
  end

  defp connected_text(conn) do
    "🟢 *Linear połączony* — zespół *#{conn.linear_team_name || conn.linear_team_id}*."
  end

  defp connect_button(project_id) do
    %{
      type: "actions",
      elements: [
        %{
          type: "button",
          action_id: "linear_connect",
          style: "primary",
          value: project_id,
          text: %{type: "plain_text", text: "Connect", emoji: true}
        }
      ]
    }
  end

  defp disconnect_button(project_id) do
    %{
      type: "actions",
      elements: [
        %{
          type: "button",
          action_id: "linear_disconnect",
          style: "danger",
          value: project_id,
          text: %{type: "plain_text", text: "Disconnect", emoji: true}
        }
      ]
    }
  end

  @doc "Opens the API-key entry modal for `project_id`, threading `response_url` through so `handle_connect_submission/4` can refresh the message that started this flow."
  @spec open_connect_modal(String.t(), String.t(), String.t(), String.t() | nil) :: :ok
  def open_connect_modal(bot_token, trigger_id, project_id, response_url) do
    private_metadata = Jason.encode!(%{project_id: project_id, response_url: response_url})

    API.post("views.open", bot_token, %{
      trigger_id: trigger_id,
      view: %{
        type: "modal",
        callback_id: @callback_id,
        private_metadata: private_metadata,
        title: %{type: "plain_text", text: "Connect Linear"},
        submit: %{type: "plain_text", text: "Connect"},
        close: %{type: "plain_text", text: "Cancel"},
        blocks: [
          %{
            type: "input",
            block_id: "api_key_block",
            label: %{type: "plain_text", text: "Personal API Key (read-only, team-scoped)"},
            element: %{type: "plain_text_input", action_id: "api_key_input"}
          }
        ]
      }
    })

    :ok
  end

  @doc """
  Handles a submitted connect modal: verifies + persists the key, DMs
  `slack_user_id` with the outcome, and refreshes the original ephemeral
  status message (via the `response_url` carried in `private_metadata`) to
  reflect the new state.

  Slack's Socket Mode envelope for this app is ack'd before async handling
  runs (see `Manfrod.Slack.Socket`), so there is no way to return a
  synchronous validation error into the modal — the modal always closes,
  and the result (success or failure) is reported via DM instead.
  """
  @spec handle_connect_submission(String.t(), String.t(), String.t(), String.t()) :: :ok
  def handle_connect_submission(bot_token, private_metadata, slack_user_id, api_key) do
    %{"project_id" => project_id, "response_url" => response_url} =
      Jason.decode!(private_metadata)

    user = Manfrod.Accounts.get_user_by_slack_id(slack_user_id)

    message =
      case Linear.connect(project_id, user && user.id, String.trim(api_key || "")) do
        {:ok, conn} ->
          "🟢 Linear connected — team *#{conn.linear_team_name || conn.linear_team_id}*."

        {:error, :invalid_key} ->
          "❌ Nieprawidłowy klucz Linear API — sprawdź czy ma uprawnienie *Read* " <>
            "i jest zawężony do właściwego zespołu (*Team access*). Uruchom " <>
            "`/linear-status` ponownie, żeby spróbować jeszcze raz."

        {:error, :no_team_scoped} ->
          "❌ Ten klucz nie jest zawężony do jednego zespołu (*Team access → Only " <>
            "select teams...*). Wygeneruj nowy klucz i uruchom `/linear-status` ponownie."

        {:error, reason} ->
          Logger.error("Linear.Status: connect failed: #{inspect(reason)}")
          "❌ Nie udało się zapisać połączenia z Linear — spróbuj ponownie."
      end

    case API.open_dm(bot_token, slack_user_id) do
      {:ok, dm_channel_id} ->
        API.post("chat.postMessage", bot_token, %{channel: dm_channel_id, text: message})

      {:error, reason} ->
        Logger.error("Linear.Status: could not DM #{slack_user_id}: #{inspect(reason)}")
    end

    case Manfrod.Repo.get(Project, project_id) do
      nil -> :ok
      project -> refresh(response_url, project)
    end

    :ok
  end
end
