# Manfrod

To start your Phoenix server:

* Run `mix setup` to install and setup dependencies
* Start Phoenix endpoint with `mix phx.server` or inside IEx with `iex -S mix phx.server`

Now you can visit [`localhost:35233`](http://localhost:35233) from your browser.

## Environment

Local `dev` and `test` commands automatically load shared environment values from Infisical `dev` at `/app`, then apply local overrides from `.env.worktree`.

One-time local setup:

```sh
infisical login --domain="https://infisical.alergeek.me"
touch .env.worktree
```

Use normal Mix commands:

```sh
mix setup
mix phx.server
iex -S mix phx.server
mix test
mix slack.export
```

Use `.env.worktree` for worktree-specific overrides such as local ports or temporary personal values. For long-term personal overrides, prefer Infisical personal overrides on `/app`.

If you need to work offline temporarily, skip only the Infisical load:

```sh
AV_SKIP_INFISICAL=1 mix phx.server
```

## Slack app configuration

The agent surface (streamed replies, task cards, suggested prompts, feedback
buttons) is configured in the Slack app itself, not in this repo. In
[api.slack.com/apps](https://api.slack.com/apps) → your app:

**Features → Agents & AI Apps** — enable it. This adds the `assistant:write`
bot scope, without which `assistant.threads.*` returns `not_allowed_token_type`.

**OAuth & Permissions → Bot Token Scopes** — beyond what the bot already
needs, streaming requires `chat:write` (already present for `chat.postMessage`).

**Event Subscriptions → Subscribe to bot events**:

| Event | What it drives |
| --- | --- |
| `assistant_thread_started` | Suggested prompts on a new thread |
| `app_home_opened` | Suggested prompts when the Messages tab is opened |
| `app_context_changed` | "Streść mi to" resolving to the channel being viewed |

Everything degrades rather than breaks if a piece is missing: without
`assistant:write` there are no prompts, titles or shimmer, but replies still
stream; if `chat.startStream` fails the answer is posted as one message. Both
layers can also be turned off outright — see `:llm_streaming` and
`:slack_streaming` in `config/config.exs`.

## Learn more

* Official website: https://www.phoenixframework.org/
* Guides: https://hexdocs.pm/phoenix/overview.html
* Docs: https://hexdocs.pm/phoenix
* Forum: https://elixirforum.com/c/phoenix-forum
* Source: https://github.com/phoenixframework/phoenix
