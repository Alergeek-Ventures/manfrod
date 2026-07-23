# Adding a tool

A tool is a module under `lib/manfrod/tools/` exporting `definitions/1`.
Nothing else to wire up — `Manfrod.Tools` discovers every compiled
`Manfrod.Tools.*` module exposing that function and merges its definitions
in automatically. No alias, no list to update in `Manfrod.Agent.Server`.

## Minimal tool

```elixir
defmodule Manfrod.Tools.MyThing do
  def definitions(%{user_id: user_id}) do
    [
      ReqLLM.Tool.new!(
        name: "do_the_thing",
        description: "One sentence the LLM uses to decide when to call this.",
        parameter_schema: [
          arg: [type: :string, required: true, doc: "What this arg means"]
        ],
        callback: fn args -> do_the_thing(user_id, args) end
      )
    ]
  end

  defp do_the_thing(user_id, %{arg: arg}) do
    {:ok, "Result the LLM sees as the tool's output"}
  end
end
```

- Module must be `Manfrod.Tools.<Something>` (three-plus segments under
  `Manfrod.Tools`) — that namespace is exactly what's auto-discovered.
- `definitions/1` takes one `ctx` map, built once per turn by
  `Manfrod.Agent.Server` and passed through unchanged. Pattern-match only
  the keys you need:
  - `:user_id` — the calling user's id
  - `:readable_levels` / `:write_access` — access levels for notes/facts
  - `:msg_ctx` — `%{channel:, ts:}` of the current message, for side effects
    like posting a file to the channel (see `Manfrod.Tools.Desks.show_desk_map`)
- Callbacks return `{:ok, result}` (shown to the LLM) or `{:error, reason}`.
  Prefer `{:ok, "friendly message"}` even for user-facing validation
  failures (e.g. "that date is in the past") — `{:error, _}` is for cases
  the LLM should treat as a real failure, not just retry-worthy feedback.
- Tool descriptions are collected into the agent's system prompt via
  `Manfrod.Tools.capabilities_text/1` — nothing to update by hand there either.

## Admin-only tools

There's no framework-level permission system — gate inside the callback,
same as `Manfrod.Tools.Desks` does for desk management (checks the caller's
email against the `:admin_emails` config, same list `/status-manfrod` uses):

```elixir
defp require_admin(user_id) do
  admin_emails = Application.get_env(:manfrod, :admin_emails, [])

  case Manfrod.Accounts.get_user!(user_id) do
    %{email: email} when email in admin_emails -> :ok
    _ -> {:ok, "Only an admin can do that."}
  end
end
```

Return the refusal as `{:ok, "..."}`, not `{:error, _}` — it's a normal
outcome the agent should just relay, not a failure to recover from.

## Removing a tool

Delete the module (or module file). That's it.
