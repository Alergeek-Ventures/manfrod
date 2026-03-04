defmodule Manfrod.Repo.Migrations.MakeAuditEventsUserIdNullable do
  use Ecto.Migration

  def change do
    # audit_events stores both user-scoped events (agent activity, memory ops)
    # and system-wide events (LLM telemetry, logger). System events have no user.
    alter table(:audit_events) do
      modify :user_id, :binary_id, null: true, from: {:binary_id, null: false}
    end
  end
end
