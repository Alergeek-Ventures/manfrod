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

  # ---------------------------------------------------------------------------
  # Agent / assistant surface
  # ---------------------------------------------------------------------------

  @doc """
  Set the "thinking" shimmer shown at the bottom of an agent thread.

  Clears itself once the app posts into the thread, so there is no matching
  "clear" call — send `""` only to drop it early.
  """
  @spec set_status(String.t(), String.t(), String.t(), String.t()) ::
          {:ok, map()} | {:error, term()}
  def set_status(token, channel, thread_ts, status) do
    post("assistant.threads.setStatus", token, %{
      channel_id: channel,
      thread_ts: thread_ts,
      status: status
    })
  end

  @doc """
  Name a thread in the agent's Messages tab. Only meaningful for assistant
  threads (DMs with the app), where Slack lists threads by title.
  """
  @spec set_title(String.t(), String.t(), String.t(), String.t()) ::
          {:ok, map()} | {:error, term()}
  def set_title(token, channel, thread_ts, title) do
    post("assistant.threads.setTitle", token, %{
      channel_id: channel,
      thread_ts: thread_ts,
      title: title
    })
  end

  @doc """
  Pin up to four suggested prompts to the top of an agent thread.

  `prompts` is a list of `%{title: ..., message: ...}` — `title` is the label
  on the button, `message` the text sent as the user when it is clicked.
  Anything beyond the first four is dropped by Slack, so trim before calling.
  """
  @spec set_suggested_prompts(String.t(), String.t(), String.t(), [map()], String.t() | nil) ::
          {:ok, map()} | {:error, term()}
  def set_suggested_prompts(token, channel, thread_ts, prompts, title \\ nil) do
    body =
      %{channel_id: channel, prompts: prompts}
      |> then(fn b -> if thread_ts, do: Map.put(b, :thread_ts, thread_ts), else: b end)
      |> then(fn b -> if title, do: Map.put(b, :title, title), else: b end)

    post("assistant.threads.setSuggestedPrompts", token, body)
  end

  @doc """
  Open a streaming message in `thread_ts` and return `{:ok, ts}` — the
  timestamp every later `append_stream/4` and `stop_stream/4` call must carry.

  `opts` may include `:chunks` (initial content, so the message never appears
  blank), `:recipient_user_id` and `:recipient_team_id` (required for streams
  in channels — the in-progress message is visible only to that user until it
  is finalized) and `:task_display_mode` (`"timeline"`, `"plan"` or `"dense"`).
  """
  @spec start_stream(String.t(), String.t(), String.t(), keyword()) ::
          {:ok, String.t()} | {:error, term()}
  def start_stream(token, channel, thread_ts, opts \\ []) do
    body =
      opts
      |> Map.new()
      |> Map.merge(%{channel: channel, thread_ts: thread_ts})

    case post("chat.startStream", token, body) do
      {:ok, %{"ts" => ts}} -> {:ok, ts}
      {:ok, body} -> {:error, {:missing_ts, body}}
      {:error, reason} -> {:error, reason}
    end
  end

  @doc """
  Append chunks to a stream opened with `start_stream/4`.

  Chunks are `markdown_text`, `task_update`, `plan_update` or `blocks` maps —
  see `Manfrod.Slack.StreamSession` for the ones this app produces.
  """
  @spec append_stream(String.t(), String.t(), String.t(), [map()]) ::
          {:ok, map()} | {:error, term()}
  def append_stream(token, channel, ts, chunks) do
    post("chat.appendStream", token, %{channel: channel, ts: ts, chunks: chunks})
  end

  @doc """
  Finalize a stream. After this the message stops rendering as in-progress and
  becomes visible to everyone in the channel.

  `chunks` is appended as the last content before finalizing — this is how the
  feedback buttons get attached without discarding what was streamed (passing
  `blocks:` instead would replace the message body).
  """
  @spec stop_stream(String.t(), String.t(), String.t(), [map()]) ::
          {:ok, map()} | {:error, term()}
  def stop_stream(token, channel, ts, chunks \\ []) do
    body =
      %{channel: channel, ts: ts}
      |> then(fn b -> if chunks == [], do: b, else: Map.put(b, :chunks, chunks) end)

    post("chat.stopStream", token, body)
  end

  @doc """
  Upload a binary as a file to Slack and share it into `channel`, via the
  current (non-deprecated) external-upload flow: `files.getUploadURLExternal`
  → raw POST of the bytes → `files.completeUploadExternal`. Requires the
  `files:write` bot token scope.

  Returns `{:ok, body}` (the `completeUploadExternal` response) or
  `{:error, reason}`.
  """
  @spec upload_file(String.t(), String.t(), String.t(), binary(), keyword()) ::
          {:ok, map()} | {:error, term()}
  def upload_file(token, channel, filename, binary, opts \\ []) do
    with {:ok, %{"upload_url" => upload_url, "file_id" => file_id}} <-
           get_upload_url(token, filename, byte_size(binary)),
         :ok <- put_file(upload_url, filename, binary) do
      complete_upload(token, channel, file_id, Keyword.get(opts, :title, filename))
    end
  end

  defp get_upload_url(token, filename, length) do
    case Req.post(client(token),
           url: "files.getUploadURLExternal",
           form: [filename: filename, length: length]
         ) do
      {:ok, %Req.Response{status: 200, body: %{"ok" => true} = body}} ->
        {:ok, body}

      {:ok, %Req.Response{status: 200, body: %{"ok" => false, "error" => error}}} ->
        Logger.error("Slack API error on files.getUploadURLExternal: #{error}")
        {:error, error}

      {:ok, %Req.Response{status: status, body: body}} ->
        Logger.error(
          "Slack API unexpected response on files.getUploadURLExternal: HTTP #{status}"
        )

        {:error, {:unexpected_status, status, body}}

      {:error, reason} ->
        Logger.error(
          "Slack API transport error on files.getUploadURLExternal: #{inspect(reason)}"
        )

        {:error, reason}
    end
  end

  defp put_file(upload_url, filename, binary) do
    case Req.post(url: upload_url, form_multipart: [file: {binary, filename: filename}]) do
      {:ok, %Req.Response{status: 200}} ->
        :ok

      {:ok, %Req.Response{status: status, body: body}} ->
        Logger.error("Slack file upload PUT failed: HTTP #{status}")
        {:error, {:unexpected_status, status, body}}

      {:error, reason} ->
        Logger.error("Slack file upload transport error: #{inspect(reason)}")
        {:error, reason}
    end
  end

  defp complete_upload(token, channel, file_id, title) do
    post("files.completeUploadExternal", token, %{
      channel_id: channel,
      files: [%{id: file_id, title: title}]
    })
  end

  @doc """
  List Slack channels the bot can see (single page, up to `limit` channels).

  Returns `{:ok, channels}` where each channel is Slack's raw
  `conversations.list` entry (`"id"`, `"name"`, `"is_private"`,
  `"is_archived"`, `"is_member"`, ...), or `{:error, reason}`.
  """
  @spec list_channels(String.t(), keyword()) :: {:ok, [map()]} | {:error, term()}
  def list_channels(token, opts \\ []) do
    params = %{
      types: Keyword.get(opts, :types, "public_channel,private_channel"),
      limit: Keyword.get(opts, :limit, 200),
      exclude_archived: true
    }

    case get("conversations.list", token, params) do
      {:ok, %{"channels" => channels}} -> {:ok, channels}
      {:error, reason} -> {:error, reason}
    end
  end

  @doc """
  Delete a message from a channel. Slack only allows deleting messages
  posted by the same bot token (without extra admin scopes), so `channel`
  and `ts` must identify a message this bot itself posted.

  Returns `{:ok, body}` or `{:error, reason}`.
  """
  @spec delete_message(String.t(), String.t(), String.t()) :: {:ok, map()} | {:error, term()}
  def delete_message(token, channel, ts) do
    post("chat.delete", token, %{channel: channel, ts: ts})
  end

  @doc """
  Look up channel info (name, im/mpim flags) by ID. Returns Slack's raw
  `conversations.info` `"channel"` map, or `{:error, reason}`.
  """
  @spec get_channel_info(String.t(), String.t()) :: {:ok, map()} | {:error, term()}
  def get_channel_info(token, channel) do
    case get("conversations.info", token, %{channel: channel}) do
      {:ok, %{"channel" => info}} -> {:ok, info}
      {:error, reason} -> {:error, reason}
    end
  end

  @doc """
  Fetch the most recent messages posted directly in a channel (top-level,
  not thread replies), oldest-first, up to `limit` (Slack default order is
  newest-first; this reverses it for chronological reading).

  Requires the `channels:history` / `groups:history` / `im:history` /
  `mpim:history` bot scope matching the channel type.

  Returns `{:ok, messages}` where each message is Slack's raw event map, or
  `{:error, reason}`.
  """
  @spec list_messages(String.t(), String.t(), keyword()) :: {:ok, [map()]} | {:error, term()}
  def list_messages(token, channel, opts \\ []) do
    params = %{channel: channel, limit: Keyword.get(opts, :limit, 20)}

    case get("conversations.history", token, params) do
      {:ok, %{"messages" => messages}} -> {:ok, Enum.reverse(messages)}
      {:error, reason} -> {:error, reason}
    end
  end

  @doc """
  Fetch all replies in a thread (including the parent message as the first
  entry), oldest-first, up to `limit`.

  Returns `{:ok, messages}` or `{:error, reason}`.
  """
  @spec list_thread_replies(String.t(), String.t(), String.t(), keyword()) ::
          {:ok, [map()]} | {:error, term()}
  def list_thread_replies(token, channel, thread_ts, opts \\ []) do
    params = %{channel: channel, ts: thread_ts, limit: Keyword.get(opts, :limit, 50)}

    case get("conversations.replies", token, params) do
      {:ok, %{"messages" => messages}} -> {:ok, messages}
      {:error, reason} -> {:error, reason}
    end
  end

  defp parse_retry_after(nil), do: 1
  defp parse_retry_after(value) when is_binary(value), do: String.to_integer(value)
end
