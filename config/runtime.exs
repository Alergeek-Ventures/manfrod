import Config
import Dotenvy

# Load .env file, system env takes precedence
source!([".env", System.get_env()])

# Database - default to local podman compose instance
database_url =
  env!("DATABASE_URL", :string, "ecto://manfrod:qLmVMeXiYyy65ADb@localhost:35232/manfrod")

if config_env() == :test do
  test_database_url =
    env!(
      "DATABASE_URL",
      :string,
      "ecto://manfrod:qLmVMeXiYyy65ADb@localhost:35232/manfrod_test#{System.get_env("MIX_TEST_PARTITION")}"
    )

  config :manfrod, Manfrod.Repo,
    url: test_database_url,
    pool: Ecto.Adapters.SQL.Sandbox,
    pool_size: System.schedulers_online() * 2

  # Oban must not run live in tests: its queue/cron polling goes through the
  # sandbox pool without an owner, crash-loops, and (via restart intensity)
  # can take the whole app down mid-suite. :manual disables queues and
  # plugins; jobs can still be asserted on / drained explicitly.
  config :manfrod, Oban, testing: :manual

  config :logger, level: :none
else
  config :manfrod, Manfrod.Repo,
    url: database_url,
    pool_size: env!("POOL_SIZE", :integer, 10)
end

# Endpoint
secret_key_base =
  env!(
    "SECRET_KEY_BASE",
    :string,
    "u4j9UKEyW8U1/ddckTtl9Va+v4X4eXQp4xu+0xnGerLY8elQoJVK5f+gKIfVvslH"
  )

config :manfrod, ManfrodWeb.Endpoint,
  http: [
    ip: {0, 0, 0, 0},
    port: env!("PORT", :integer, 35233)
  ],
  secret_key_base: secret_key_base,
  server: config_env() != :test,
  # Allow websocket connections from Tailscale hosts
  check_origin: :conn

if config_env() == :prod do
  # `force_ssl` lives in config.exs (compile-time) — it shapes the Endpoint's
  # plug pipeline, which Phoenix builds at compile time.
  config :manfrod, ManfrodWeb.Endpoint,
    url: [host: env!("PHX_HOST", :string, "localhost"), port: 443, scheme: "https"]
end

# Zen API (Kimi K2.5)
config :manfrod, :zen_api_key, env!("ZEN_API_KEY", :string?)

# OpenRouter API
config :manfrod, :openrouter_api_key, env!("OPENROUTER_API_KEY", :string?)

# Voyage AI (embeddings + reranking)
config :manfrod, :voyage_api_key, env!("VOYAGE_API_KEY", :string?)

# Groq API (query expansion)
config :manfrod, :groq_api_key, env!("GROQ_API_KEY", :string?)

# Brave Search API (web search)
config :manfrod, :brave_search_api_key, env!("BRAVE_SEARCH_API_KEY", :string?)

# Slack (Socket Mode bot)
config :manfrod, :slack_app_token, env!("SLACK_APP_TOKEN", :string?)
config :manfrod, :slack_bot_token, env!("SLACK_BOT_TOKEN", :string?)

# Google OAuth (Sign-In + Calendar)
config :manfrod, :google_client_id, env!("GOOGLE_CLIENT_ID", :string?)
config :manfrod, :google_client_secret, env!("GOOGLE_CLIENT_SECRET", :string?)

config :manfrod, :google_api_key, env!("GOOGLE_API_KEY", :string?, nil)

config :manfrod,
       :holiday_calendar_id,
       env!("HOLIDAY_CALENDAR_ID", :string, "pl.polish#holiday@group.v.calendar.google.com")
