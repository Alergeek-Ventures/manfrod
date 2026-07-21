# Based on slack_elixir v1.2.1 (MIT) — https://github.com/ryanwinchester/slack_elixir

defmodule Manfrod.Slack.API do
  @moduledoc """
  Thin Req wrapper for Slack's Web API.
  """

  require Logger

  @base_url "https://slack.com/api"

  @doc """
  Build a configured Req client for the Slack API.
  """
  @spec client(String.t()) :: Req.Request.t()
  def client(token) do
    Req.new(base_url: @base_url, auth: {:bearer, token})
  end

  @doc """
  GET a Slack Web API endpoint.

  Returns `{:ok, body}` when Slack responds with `"ok" => true`,
  `{:error, reason}` otherwise.
  """
  @spec get(String.t(), String.t(), map()) :: {:ok, map()} | {:error, term()}
  def get(endpoint, token, params \\ %{}) do
    case Req.get(client(token), url: endpoint, params: params) do
      {:ok, %Req.Response{status: 200, body: %{"ok" => true} = body}} ->
        {:ok, body}

      {:ok, %Req.Response{status: 200, body: %{"ok" => false, "error" => error}}} ->
        Logger.error("Slack API error on GET #{endpoint}: #{error}")
        {:error, error}

      {:ok, %Req.Response{status: status, body: body}} ->
        Logger.error("Slack API unexpected response on GET #{endpoint}: HTTP #{status}")
        {:error, {:unexpected_status, status, body}}

      {:error, reason} ->
        Logger.error("Slack API transport error on GET #{endpoint}: #{inspect(reason)}")
        {:error, reason}
    end
  end

  @doc """
  POST to a Slack Web API endpoint with JSON body.

  Handles 429 (rate limit) by sleeping for the `Retry-After` duration and
  retrying once. Returns `{:ok, body}` when Slack responds with `"ok" => true`,
  `{:error, reason}` otherwise.
  """
  @spec post(String.t(), String.t(), map()) :: {:ok, map()} | {:error, term()}
  def post(endpoint, token, body \\ %{}) do
    do_post(endpoint, token, body, _retried: false)
  end

  defp do_post(endpoint, token, body, _retried: retried) do
    case Req.post(client(token), url: endpoint, json: body) do
      {:ok, %Req.Response{status: 200, body: %{"ok" => true} = resp_body}} ->
        {:ok, resp_body}

      {:ok, %Req.Response{status: 200, body: %{"ok" => false, "error" => error}}} ->
        Logger.error("Slack API error on POST #{endpoint}: #{error}")
        {:error, error}

      {:ok, %Req.Response{status: 429} = response} when not retried ->
        retry_after =
          response
          |> Req.Response.get_header("retry-after")
          |> List.first()
          |> parse_retry_after()

        Logger.warning("Slack API rate limited on POST #{endpoint}, retrying in #{retry_after}s")

        Process.sleep(retry_after * 1000)
        do_post(endpoint, token, body, _retried: true)

      {:ok, %Req.Response{status: 429}} ->
        Logger.error("Slack API rate limited on POST #{endpoint} after retry")
        {:error, :rate_limited}

      {:ok, %Req.Response{status: status, body: resp_body}} ->
        Logger.error("Slack API unexpected response on POST #{endpoint}: HTTP #{status}")
        {:error, {:unexpected_status, status, resp_body}}

      {:error, reason} ->
        Logger.error("Slack API transport error on POST #{endpoint}: #{inspect(reason)}")
        {:error, reason}
    end
  end

  @doc """
  Fetch a user's display name from Slack.

  Returns `{:ok, name}` or `:error`. Prefers `real_name`, falls back to `name`.
  """
  def fetch_user_name(token, slack_user_id) do
    case get("users.info", token, %{user: slack_user_id}) do
      {:ok, %{"user" => %{"real_name" => name}}} when name != "" -> {:ok, name}
      {:ok, %{"user" => %{"name" => name}}} when name != "" -> {:ok, name}
      _ -> :error
    end
  end

  @doc """
  Fetch a user's display name and email from Slack.

  Returns `{:ok, %{name: name, email: email}}` or `:error`.
  The email field requires the `users:read.email` bot token scope.
  If the scope is missing, `email` will be nil.
  """
  def fetch_user_info(token, slack_user_id) do
    case get("users.info", token, %{user: slack_user_id}) do
      {:ok, %{"user" => user}} ->
        name =
          case user do
            %{"real_name" => name} when name != "" -> name
            %{"name" => name} when name != "" -> name
            _ -> nil
          end

        email = get_in(user, ["profile", "email"])

        {:ok, %{name: name, email: email}}

      _ ->
        :error
    end
  end

  @doc """
  Add an emoji reaction to a message.

  `emoji` is the Slack emoji name without colons (e.g. `"eyes"`, `"thumbsup"`).
  Returns `{:ok, body}` or `{:error, reason}` — `"already_reacted"` is a
  common, harmless error when the same reaction is already present (e.g.
  duplicate event delivery), safe to ignore.
  """
  @spec add_reaction(String.t(), String.t(), String.t(), String.t()) ::
          {:ok, map()} | {:error, term()}
  def add_reaction(token, channel, ts, emoji) do
    post("reactions.add", token, %{channel: channel, timestamp: ts, name: emoji})
  end

  defp parse_retry_after(nil), do: 1
  defp parse_retry_after(value) when is_binary(value), do: String.to_integer(value)
end
