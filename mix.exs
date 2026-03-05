defmodule Manfrod.MixProject do
  use Mix.Project

  def project do
    [
      app: :manfrod,
      version: "0.1.0",
      elixir: "~> 1.15",
      elixirc_paths: elixirc_paths(Mix.env()),
      start_permanent: true,
      aliases: aliases(),
      deps: deps(),
      listeners: [Phoenix.CodeReloader]
    ]
  end

  defp elixirc_paths(:test), do: ["lib", "test/support"]
  defp elixirc_paths(_), do: ["lib"]

  def application do
    [
      mod: {Manfrod.Application, []},
      extra_applications: [:logger, :runtime_tools]
    ]
  end

  defp deps do
    [
      {:dotenvy, "~> 1.0"},
      {:phoenix, "~> 1.8.3"},
      {:phoenix_ecto, "~> 4.5"},
      {:ecto_sql, "~> 3.13"},
      {:postgrex, ">= 0.0.0"},
      {:phoenix_live_dashboard, "~> 0.8.3"},
      {:req, "~> 0.5"},
      {:req_llm, "~> 1.4"},
      {:jason, "~> 1.2"},
      {:bandit, "~> 1.5"},
      {:tidewave, "~> 0.5.4"},
      {:pgvector, "~> 0.3"},
      {:paradex, "~> 0.4"},
      {:oban, "~> 2.20"},
      {:oban_web, "~> 2.11"},
      {:crontab, "~> 1.1"},
      {:tzdata, "~> 1.1"},
      {:tailwind, "~> 0.3", runtime: Mix.env() == :dev},
      {:websockex, "~> 0.5.1"},
      {:mox, "~> 1.0", only: :test}
    ]
  end

  defp aliases do
    [
      setup: ["deps.get", "ecto.setup", "assets.setup", "assets.build"],
      "ecto.setup": ["ecto.create", "ecto.migrate", "run priv/repo/seeds.exs"],
      "ecto.reset": ["ecto.drop", "ecto.setup"],
      "assets.setup": ["tailwind.install --if-missing"],
      "assets.build": ["tailwind manfrod"],
      "assets.deploy": ["tailwind manfrod --minify"]
    ]
  end
end
