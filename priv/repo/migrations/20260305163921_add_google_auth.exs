defmodule Manfrod.Repo.Migrations.AddGoogleAuth do
  use Ecto.Migration

  def change do
    # Add email to users (optional, backfilled from Slack or Google)
    alter table(:users) do
      add :email, :string
    end

    create unique_index(:users, [:email])

    # Google identity — linked 1:1 to a user
    create table(:google_identities, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      add :google_sub, :string, null: false
      add :access_token, :text
      add :refresh_token, :text
      add :token_expires_at, :integer

      timestamps()
    end

    create unique_index(:google_identities, [:user_id])
    create unique_index(:google_identities, [:google_sub])

    # Session tokens for web auth
    create table(:user_tokens, primary_key: false) do
      add :id, :binary_id, primary_key: true
      add :user_id, references(:users, type: :binary_id, on_delete: :delete_all), null: false
      add :token, :binary, null: false
      add :context, :string, null: false

      timestamps(updated_at: false)
    end

    create index(:user_tokens, [:user_id])
    create unique_index(:user_tokens, [:context, :token])
  end
end
