defmodule ManfrodWeb.Admin.AccessLive do
  use ManfrodWeb, :live_view

  import Ecto.Query

  alias Manfrod.Accounts
  alias Manfrod.Facts
  alias Manfrod.Memory
  alias Manfrod.Repo
  alias Manfrod.Memory.{ChannelMapping, Fact, Project, ProjectMembership}
  alias Manfrod.Skills

  @impl true
  def mount(_params, _session, socket) do
    {:ok,
     socket
     |> assign(tab: "channels")
     |> assign(show_add_project: false)
     |> assign(add_project_form: %{"slug" => "", "name" => ""})
     |> assign(
       vacation_form: %{
         "user_id" => "",
         "start_date" => "",
         "end_date" => "",
         "note" => "vacation"
       }
     )
     |> assign(editing_vacation_id: nil)
     |> assign(editing_vacation_value: "")
     |> assign(editing_cron_id: nil)
     |> assign(editing_cron_form: %{})
     |> load_data()}
  end

  @impl true
  def handle_params(%{"tab" => tab}, _uri, socket)
      when tab in ~w(projects channels members vacations cron reminders) do
    {:noreply, assign(socket, tab: tab)}
  end

  def handle_params(_params, _uri, socket), do: {:noreply, socket}

  @impl true
  def handle_event("switch_tab", %{"tab" => tab}, socket) do
    {:noreply, push_patch(socket, to: ~p"/admin/access?tab=#{tab}")}
  end

  def handle_event("toggle_add_project", _params, socket) do
    {:noreply, assign(socket, show_add_project: !socket.assigns.show_add_project)}
  end

  def handle_event("update_add_project", %{"field" => field, "value" => value}, socket) do
    form = Map.put(socket.assigns.add_project_form, field, value)
    {:noreply, assign(socket, add_project_form: form)}
  end

  def handle_event("save_project", _params, socket) do
    %{"slug" => slug, "name" => name} = socket.assigns.add_project_form

    case Repo.insert(Project.changeset(%Project{}, %{slug: slug, name: name})) do
      {:ok, _project} ->
        {:noreply,
         socket
         |> assign(show_add_project: false)
         |> assign(add_project_form: %{"slug" => "", "name" => ""})
         |> load_data()
         |> put_flash(:info, "Project added")}

      {:error, changeset} ->
        errors = Enum.map_join(changeset.errors, ", ", fn {k, {msg, _}} -> "#{k}: #{msg}" end)
        {:noreply, put_flash(socket, :error, "Error: #{errors}")}
    end
  end

  def handle_event("update_vacation_form", %{"field" => field, "value" => value}, socket) do
    form = Map.put(socket.assigns.vacation_form, field, value)
    {:noreply, assign(socket, vacation_form: form)}
  end

  def handle_event("update_vacation_form", params, socket) do
    allowed = Map.take(params, ["user_id", "start_date", "end_date", "note"])
    {:noreply, assign(socket, vacation_form: Map.merge(socket.assigns.vacation_form, allowed))}
  end

  def handle_event("save_vacation", _params, socket) do
    %{"user_id" => user_id, "start_date" => start_date, "end_date" => end_date, "note" => note} =
      socket.assigns.vacation_form

    cond do
      user_id == "" or start_date == "" or end_date == "" ->
        {:noreply, put_flash(socket, :error, "Select a person and vacation dates")}

      true ->
        key = "absence:#{user_id}:#{start_date}"
        value = "#{start_date}..#{end_date} — #{blank_to_default(note, "vacation")}"

        case Facts.set_fact(key, value, ["internal", "external/all"], user_id) do
          {:ok, _fact} ->
            {:noreply,
             socket
             |> assign(
               vacation_form: %{
                 "user_id" => user_id,
                 "start_date" => "",
                 "end_date" => "",
                 "note" => "vacation"
               }
             )
             |> load_data()
             |> put_flash(:info, "Vacation saved")}

          {:error, changeset} ->
            {:noreply, put_flash(socket, :error, "Error: #{format_changeset_errors(changeset)}")}
        end
    end
  end

  def handle_event("edit_vacation", %{"id" => id}, socket) do
    case Repo.get(Fact, id) do
      nil ->
        {:noreply, put_flash(socket, :error, "Vacation not found")}

      fact ->
        {:noreply,
         assign(socket, editing_vacation_id: fact.id, editing_vacation_value: fact.value)}
    end
  end

  def handle_event("update_vacation_value", %{"value" => value}, socket) do
    {:noreply, assign(socket, editing_vacation_value: value)}
  end

  def handle_event("cancel_edit_vacation", _params, socket) do
    {:noreply, assign(socket, editing_vacation_id: nil, editing_vacation_value: "")}
  end

  def handle_event("save_vacation_edit", %{"id" => id}, socket) do
    case Repo.get(Fact, id) do
      nil ->
        {:noreply, put_flash(socket, :error, "Vacation not found")}

      fact ->
        case Repo.update(Fact.changeset(fact, %{value: socket.assigns.editing_vacation_value})) do
          {:ok, _fact} ->
            {:noreply,
             socket
             |> assign(editing_vacation_id: nil, editing_vacation_value: "")
             |> load_data()
             |> put_flash(:info, "Vacation updated")}

          {:error, changeset} ->
            {:noreply, put_flash(socket, :error, "Error: #{format_changeset_errors(changeset)}")}
        end
    end
  end

  def handle_event("delete_vacation", %{"id" => id}, socket) do
    case Repo.get(Fact, id) do
      nil ->
        {:noreply, put_flash(socket, :error, "Vacation not found")}

      fact ->
        Repo.delete(fact)

        {:noreply,
         socket
         |> load_data()
         |> put_flash(:info, "Vacation deleted")}
    end
  end

  def handle_event("edit_cron", %{"id" => id}, socket) do
    case Memory.get_recurring_reminder(id) do
      nil ->
        {:noreply, put_flash(socket, :error, "Cron not found")}

      reminder ->
        {:noreply,
         assign(socket,
           editing_cron_id: reminder.id,
           editing_cron_form: %{
             "cron" => reminder.cron,
             "timezone" => reminder.timezone,
             "instructions" => reminder.instructions
           }
         )}
    end
  end

  def handle_event("update_cron_form", %{"field" => field, "value" => value}, socket) do
    form = Map.put(socket.assigns.editing_cron_form, field, value)
    {:noreply, assign(socket, editing_cron_form: form)}
  end

  def handle_event("cancel_edit_cron", _params, socket) do
    {:noreply, assign(socket, editing_cron_id: nil, editing_cron_form: %{})}
  end

  def handle_event("save_cron_edit", %{"id" => id}, socket) do
    case Memory.get_recurring_reminder(id) do
      nil ->
        {:noreply, put_flash(socket, :error, "Cron not found")}

      reminder ->
        %{"cron" => cron, "timezone" => timezone, "instructions" => instructions} =
          socket.assigns.editing_cron_form

        attrs = %{cron: cron, timezone: timezone, instructions: instructions}

        case Memory.update_recurring_reminder(reminder.user_id, reminder, attrs) do
          {:ok, _updated} ->
            {:noreply,
             socket
             |> assign(editing_cron_id: nil, editing_cron_form: %{})
             |> load_data()
             |> put_flash(:info, "Cron updated")}

          {:error, changeset} ->
            {:noreply, put_flash(socket, :error, "Error: #{format_changeset_errors(changeset)}")}
        end
    end
  end

  def handle_event("toggle_cron_enabled", %{"id" => id}, socket) do
    case Memory.get_recurring_reminder(id) do
      nil ->
        {:noreply, put_flash(socket, :error, "Cron not found")}

      reminder ->
        case Memory.update_recurring_reminder(reminder.user_id, reminder, %{
               enabled: !reminder.enabled
             }) do
          {:ok, _updated} ->
            {:noreply, socket |> load_data() |> put_flash(:info, "Updated")}

          {:error, changeset} ->
            {:noreply, put_flash(socket, :error, "Error: #{format_changeset_errors(changeset)}")}
        end
    end
  end

  def handle_event("delete_cron", %{"id" => id}, socket) do
    case Memory.get_recurring_reminder(id) do
      nil ->
        {:noreply, put_flash(socket, :error, "Cron not found")}

      reminder ->
        case Memory.delete_recurring_reminder(reminder.user_id, reminder) do
          {:ok, _deleted} ->
            {:noreply, socket |> load_data() |> put_flash(:info, "Cron deleted")}

          {:error, _reason} ->
            {:noreply, put_flash(socket, :error, "Failed to delete cron")}
        end
    end
  end

  def handle_event("cancel_reminder", %{"id" => id}, socket) do
    :ok = Oban.cancel_job(String.to_integer(id))

    {:noreply, socket |> load_data() |> put_flash(:info, "Reminder cancelled")}
  end

  def handle_event("activate_mapping", %{"id" => id}, socket) do
    toggle_mapping_status(id, "active", socket)
  end

  def handle_event("deactivate_mapping", %{"id" => id}, socket) do
    toggle_mapping_status(id, "pending", socket)
  end

  def handle_event("delete_mapping", %{"id" => id}, socket) do
    case Repo.get(ChannelMapping, id) do
      nil ->
        {:noreply, put_flash(socket, :error, "Mapping not found")}

      mapping ->
        Repo.delete(mapping)
        {:noreply, socket |> load_data() |> put_flash(:info, "Deleted")}
    end
  end

  defp toggle_mapping_status(id, new_status, socket) do
    case Repo.get(ChannelMapping, id) do
      nil ->
        {:noreply, put_flash(socket, :error, "Mapping not found")}

      mapping ->
        mapping
        |> ChannelMapping.changeset(%{status: new_status})
        |> Repo.update()

        {:noreply, socket |> load_data() |> put_flash(:info, "Updated")}
    end
  end

  defp load_data(socket) do
    projects =
      Repo.all(
        from p in Project,
          left_join: cm in ChannelMapping,
          on: cm.project_id == p.id,
          left_join: pm in ProjectMembership,
          on: pm.project_id == p.id,
          group_by: p.id,
          select: %{
            id: p.id,
            slug: p.slug,
            name: p.name,
            channel_count: count(cm.id, :distinct),
            member_count: count(pm.id, :distinct)
          },
          order_by: p.slug
      )

    channels =
      Repo.all(
        from cm in ChannelMapping,
          left_join: p in Project,
          on: p.id == cm.project_id,
          select: %{
            id: cm.id,
            slack_channel_id: cm.slack_channel_id,
            slack_channel_name: cm.slack_channel_name,
            client_id: cm.client_id,
            status: cm.status,
            source: cm.source,
            project_slug: p.slug
          },
          order_by: [desc: cm.inserted_at]
      )

    members =
      Repo.all(
        from pm in ProjectMembership,
          join: u in Manfrod.Accounts.User,
          on: u.id == pm.user_id,
          join: p in Project,
          on: p.id == pm.project_id,
          select: %{
            user_name: u.name,
            user_slack_id: u.slack_id,
            project_name: p.name,
            project_slug: p.slug,
            source: pm.source
          },
          order_by: [u.name, p.slug]
      )
      |> Enum.group_by(& &1.user_slack_id)
      |> Enum.map(fn {slack_id, rows} ->
        %{
          user_slack_id: slack_id,
          user_name: List.first(rows).user_name,
          memberships: Enum.map(rows, &Map.take(&1, [:project_name, :project_slug, :source]))
        }
      end)
      |> Enum.sort_by(& &1.user_name)

    users = Accounts.list_users()

    vacations =
      Repo.all(
        from f in Fact,
          left_join: u in Manfrod.Accounts.User,
          on: u.id == f.set_by_user_id,
          where: like(f.key, "absence:%"),
          select: %{
            id: f.id,
            key: f.key,
            value: f.value,
            access: f.access,
            user_name: u.name,
            user_slack_id: u.slack_id,
            inserted_at: f.inserted_at,
            updated_at: f.updated_at
          },
          order_by: [desc: f.inserted_at]
      )

    cron_rows = build_cron_rows()
    reminder_rows = build_reminder_rows(users)

    socket
    |> assign(projects: projects)
    |> assign(channels: channels)
    |> assign(members: members)
    |> assign(users: users)
    |> assign(vacations: vacations)
    |> assign(cron_rows: cron_rows)
    |> assign(reminder_rows: reminder_rows)
  end

  # Skill-crons (from SKILL.md frontmatter, read-only, no owning user) and
  # user recurring reminders (DB-backed, editable/deletable, owned by a
  # user) are structurally different, but the admin cron tab shows them as
  # one merged, sortable list — so normalize both into a common row shape
  # here rather than juggling two shapes in the template.
  defp build_cron_rows do
    skill_rows =
      Skills.list_cron_skills()
      |> Enum.map(fn skill ->
        %{
          type: :skill,
          id: nil,
          name: skill.name,
          cron: skill.cron,
          timezone: "Europe/Warsaw",
          enabled: true,
          owner_name: "Skill",
          owner_slack_id: nil,
          detail: skill.description,
          channel: skill.channel
        }
      end)

    user_rows =
      Memory.list_all_recurring_reminders()
      |> Enum.map(fn reminder ->
        %{
          type: :user,
          id: reminder.id,
          name: reminder.name,
          cron: reminder.cron,
          timezone: reminder.timezone,
          enabled: reminder.enabled,
          owner_name: reminder.user && reminder.user.name,
          owner_slack_id: reminder.user && reminder.user.slack_id,
          detail: reminder.instructions,
          channel: nil
        }
      end)

    Enum.sort_by(skill_rows ++ user_rows, & &1.name)
  end

  # One-time reminders (from `set_reminder`) are plain Oban jobs, not DB
  # rows of their own — pull them from the jobs table and match them back
  # to users in-memory rather than joining, since args is a jsonb blob.
  defp build_reminder_rows(users) do
    jobs =
      Oban.Job
      |> where([j], j.worker == "Manfrod.Workers.TriggerWorker")
      |> where([j], j.state in ["scheduled", "available"])
      |> where([j], fragment("?->>'trigger_id' LIKE 'reminder_%'", j.args))
      |> order_by([j], asc: j.scheduled_at)
      |> Repo.all()

    users_by_id = Map.new(users, &{&1.id, &1})

    Enum.map(jobs, fn job ->
      user = Map.get(users_by_id, job.args["user_id"])

      %{
        id: job.id,
        message: String.replace_prefix(job.args["prompt"] || "", "[Reminder] ", ""),
        scheduled_at: job.scheduled_at,
        state: job.state,
        owner_name: user && user.name,
        owner_slack_id: user && user.slack_id
      }
    end)
  end

  # Skill rows carry `id: nil` (there's no DB row behind them) and
  # `editing_cron_id` is nil whenever nothing is being edited — so a bare
  # `@editing_cron_id == row.id` is true for every skill row at rest and
  # renders them all as edit forms. Only user rows are ever editable.
  defp editing?(editing_cron_id, row) do
    row.type == :user and editing_cron_id == row.id
  end

  defp blank_to_default("", default), do: default
  defp blank_to_default(nil, default), do: default
  defp blank_to_default(value, _default), do: value

  defp format_changeset_errors(changeset) do
    Enum.map_join(changeset.errors, ", ", fn {k, {msg, _}} -> "#{k}: #{msg}" end)
  end
end
