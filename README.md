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

## Learn more

* Official website: https://www.phoenixframework.org/
* Guides: https://hexdocs.pm/phoenix/overview.html
* Docs: https://hexdocs.pm/phoenix
* Forum: https://elixirforum.com/c/phoenix-forum
* Source: https://github.com/phoenixframework/phoenix
