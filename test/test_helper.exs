# LLM-backed tests are opt-in: :slow needs a live agent/LLM backend
# (times out without one), :external_api hits real third-party APIs.
# Run them with `mix test --include slow --include external_api`.
ExUnit.start(exclude: [:slow, :external_api])
Ecto.Adapters.SQL.Sandbox.mode(Manfrod.Repo, :manual)
