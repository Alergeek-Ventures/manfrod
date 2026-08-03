defmodule Manfrod.Repo.Migrations.CreateMessageFeedback do
  use Ecto.Migration

  def change do
    # Ratings are also broadcast as :feedback_received activity events, but
    # audit_events are purged after 7 days — and a table of "answers people
    # told us were wrong" is exactly the thing you want to still have in three
    # months. This is the durable copy, and the one the analytics page reads.
    create table(:message_feedback, primary_key: false) do
      add :id, :binary_id, primary_key: true

      # Nullable: someone can rate an answer in a channel without ever having
      # DMed the bot, so there may be no Manfrod user behind the Slack id.
      add :user_id, references(:users, type: :binary_id, on_delete: :nilify_all)
      add :slack_user_id, :string
      # Denormalized so the list still names people whose account is later
      # removed, and so rendering it needs no joins or Slack lookups.
      add :slack_user_name, :string

      add :slack_channel_id, :string, null: false
      add :slack_channel_name, :string
      add :message_ts, :string, null: false
      add :session_key, :string

      add :rating, :string, null: false
      # Resolved once, when the rating comes in — chat.getPermalink needs the
      # message to still exist, which is not guaranteed by the time an admin
      # opens the page.
      add :permalink, :string

      timestamps()
    end

    # Slack lets a person change their mind, which arrives as another click on
    # the same message. One row per person per message, updated in place, so a
    # flip-flop doesn't count as two ratings.
    create unique_index(
             :message_feedback,
             [:slack_channel_id, :message_ts, :slack_user_id],
             name: :message_feedback_rater_index,
             nulls_distinct: false
           )

    create index(:message_feedback, [:inserted_at])
    create index(:message_feedback, [:rating])
    create index(:message_feedback, [:user_id])
  end
end
