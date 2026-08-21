defmodule Manfrod.Linear.Status do
  @moduledoc """
  The `/linear-status` UI: an ephemeral connect/connected message with a
  button, a modal to paste the API key, and the DM that reports the result.

  Ephemeral rather than a channel post — this is a key-management flow, kept
  out of channel history. The key itself is only ever typed into a Slack
  modal, which is never persisted to any message history at all (Block
  Kit's `input`/`plain_text_input` elements only exist inside modals or the
  Home tab — not in regular or ephemeral messages).
  """

  require Logger

  alias Manfrod.Linear
  alias Manfrod.Memory.Project
  alias Manfrod.Slack.API

  @callback_id "linear_connect_modal"

  @doc "Posts the ephemeral connect/connected status for `project` into `channel_id`, visible only to `slack_user_id`."
  @spec post_status(String.t(), String.t(), String.t(), Project.t()) :: :ok
  def post_status(bot_token, channel_id, slack_user_id, %Project{} = project) do
    text =
      case Linear.get_connection(project.id) do
        nil -> disconnected_text(project)
        conn -> connected_text(conn)
      end

    blocks =
      case Linear.get_connection(project.id) do
        nil -> [connect_button(project.id)]
        _conn -> [disconnect_button(project.id)]
      end

    API.post("chat.postEphemeral", bot_token, %{
      channel: channel_id,
      user: slack_user_id,
      text: text,
      blocks: [%{type: "section", text: %{type: "mrkdwn", text: text}} | blocks]
    })

    :ok
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

  @doc "Opens the API-key entry modal for `project_id`."
  @spec open_connect_modal(String.t(), String.t(), String.t()) :: :ok
  def open_connect_modal(bot_token, trigger_id, project_id) do
    API.post("views.open", bot_token, %{
      trigger_id: trigger_id,
      view: %{
        type: "modal",
        callback_id: @callback_id,
        private_metadata: project_id,
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
  Handles a submitted connect modal: verifies + persists the key, then DMs
  `slack_user_id` with the outcome.

  Slack's Socket Mode envelope for this app is ack'd before async handling
  runs (see `Manfrod.Slack.Socket`), so there is no way to return a
  synchronous validation error into the modal — the modal always closes,
  and the result (success or failure) is reported via DM instead.
  """
  @spec handle_connect_submission(String.t(), String.t(), String.t(), String.t()) :: :ok
  def handle_connect_submission(bot_token, project_id, slack_user_id, api_key) do
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

    :ok
  end
end
