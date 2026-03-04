# Based on slack_elixir v1.2.1 (MIT) — https://github.com/ryanwinchester/slack_elixir

defmodule Manfrod.Slack.Bot do
  @moduledoc """
  Bot identity struct fetched via `auth.test` on startup.
  """

  @derive {Inspect, except: [:token]}
  @enforce_keys [:id, :token, :team_id, :user_id]

  defstruct [:id, :token, :team_id, :user_id]

  @type t :: %__MODULE__{
          id: String.t(),
          token: String.t(),
          team_id: String.t(),
          user_id: String.t()
        }

  @doc """
  Build a `Bot` struct from a bot token and the `auth.test` response map.

  The response map uses string keys: `"bot_id"`, `"team_id"`, `"user_id"`.
  """
  @spec from_auth_test(String.t(), map()) :: t()
  def from_auth_test(bot_token, %{"bot_id" => bot_id, "team_id" => team_id, "user_id" => user_id}) do
    %__MODULE__{
      id: bot_id,
      token: bot_token,
      team_id: team_id,
      user_id: user_id
    }
  end
end
