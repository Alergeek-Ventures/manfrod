defmodule Manfrod.Repo.Migrations.CreateThreadKicks do
  use Ecto.Migration

  def change do
    # `Manfrod.Slack.ThreadPermission` normally re-derives its verdicts from
    # Slack itself, by scanning a thread for a `<@bot>` mention. A kick cannot
    # work that way: the mention that invited the bot is still sitting in the
    # thread, so the next re-derivation would invite it straight back. This
    # table is the durable "no" that outranks that scan, and the reason a kick
    # survives a restart or a cache sweep.
    create table(:thread_kicks, primary_key: false) do
      add :id, :binary_id, primary_key: true

      add :slack_channel_id, :string, null: false
      add :thread_ts, :string, null: false

      # Who did it, for the audit trail — nullable because a kick can come
      # from a Slack user with no Manfrod account behind them.
      add :user_id, references(:users, type: :binary_id, on_delete: :nilify_all)
      add :slack_user_id, :string
      # "shortcut" (the message action) or "tool" (the agent kicked itself
      # because someone asked it to), so the two paths stay tellable apart.
      add :source, :string, null: false

      timestamps()
    end

    # One kick per thread. Kicking an already-kicked thread is a no-op, not a
    # second row, and lookups are keyed on exactly this pair.
    create unique_index(:thread_kicks, [:slack_channel_id, :thread_ts])
  end
end
