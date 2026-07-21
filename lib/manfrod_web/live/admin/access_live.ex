defmodule ManfrodWeb.Admin.AccessLive do
  use ManfrodWeb, :live_view

  import Ecto.Query

  alias Manfrod.Accounts
  alias Manfrod.Facts
  alias Manfrod.Repo
  alias Manfrod.Memory.{ChannelMapping, Fact, Project, ProjectMembership}

  @impl true
  def mount(_params, _session, socket) do
    {:ok,
     socket
     |> assign(tab: "channels")
     |> assign(show_add_project: false)
     |> assign(add_project_form: %{"slug" => "", "name" => ""})
     |> assign(
       vacation_form: %{"user_id" => "", "start_date" => "", "end_date" => "", "note" => "urlop"}
     )
     |> assign(editing_vacation_id: nil)
     |> assign(editing_vacation_value: "")
     |> load_data()}
  end

  @impl true
  def handle_params(%{"tab" => tab}, _uri, socket)
      when tab in ~w(projects channels members vacations) do
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
         |> put_flash(:info, "Projekt dodany")}

      {:error, changeset} ->
        errors = Enum.map_join(changeset.errors, ", ", fn {k, {msg, _}} -> "#{k}: #{msg}" end)
        {:noreply, put_flash(socket, :error, "Błąd: #{errors}")}
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
        {:noreply, put_flash(socket, :error, "Wybierz osobę i daty urlopu")}

      true ->
        key = "vacation:#{user_id}:#{start_date}"
        value = "#{start_date}..#{end_date} — #{blank_to_default(note, "urlop")}"

        case Facts.set_fact(key, value, ["internal", "external/all"], user_id) do
          {:ok, _fact} ->
            {:noreply,
             socket
             |> assign(
               vacation_form: %{
                 "user_id" => user_id,
                 "start_date" => "",
                 "end_date" => "",
                 "note" => "urlop"
               }
             )
             |> load_data()
             |> put_flash(:info, "Urlop zapisany")}

          {:error, changeset} ->
            {:noreply, put_flash(socket, :error, "Błąd: #{format_changeset_errors(changeset)}")}
        end
    end
  end

  def handle_event("edit_vacation", %{"id" => id}, socket) do
    case Repo.get(Fact, id) do
      nil ->
        {:noreply, put_flash(socket, :error, "Nie znaleziono urlopu")}

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
        {:noreply, put_flash(socket, :error, "Nie znaleziono urlopu")}

      fact ->
        case Repo.update(Fact.changeset(fact, %{value: socket.assigns.editing_vacation_value})) do
          {:ok, _fact} ->
            {:noreply,
             socket
             |> assign(editing_vacation_id: nil, editing_vacation_value: "")
             |> load_data()
             |> put_flash(:info, "Urlop zaktualizowany")}

          {:error, changeset} ->
            {:noreply, put_flash(socket, :error, "Błąd: #{format_changeset_errors(changeset)}")}
        end
    end
  end

  def handle_event("delete_vacation", %{"id" => id}, socket) do
    case Repo.get(Fact, id) do
      nil ->
        {:noreply, put_flash(socket, :error, "Nie znaleziono urlopu")}

      fact ->
        Repo.delete(fact)

        {:noreply,
         socket
         |> load_data()
         |> put_flash(:info, "Urlop usunięty")}
    end
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
        {:noreply, put_flash(socket, :error, "Nie znaleziono mappingu")}

      mapping ->
        Repo.delete(mapping)
        {:noreply, socket |> load_data() |> put_flash(:info, "Usunięto")}
    end
  end

  defp toggle_mapping_status(id, new_status, socket) do
    case Repo.get(ChannelMapping, id) do
      nil ->
        {:noreply, put_flash(socket, :error, "Nie znaleziono mappingu")}

      mapping ->
        mapping
        |> ChannelMapping.changeset(%{status: new_status})
        |> Repo.update()

        {:noreply, socket |> load_data() |> put_flash(:info, "Zaktualizowano")}
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
          where: like(f.key, "vacation:%") or like(f.key, "absence:%"),
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

    socket
    |> assign(projects: projects)
    |> assign(channels: channels)
    |> assign(members: members)
    |> assign(users: users)
    |> assign(vacations: vacations)
  end

  defp blank_to_default("", default), do: default
  defp blank_to_default(nil, default), do: default
  defp blank_to_default(value, _default), do: value

  defp format_changeset_errors(changeset) do
    Enum.map_join(changeset.errors, ", ", fn {k, {msg, _}} -> "#{k}: #{msg}" end)
  end
end
