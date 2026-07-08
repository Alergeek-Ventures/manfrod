defmodule Manfrod.Memory.Admin do
  @moduledoc """
  Admin API for access isolation setup.

  Keeps project, channel mapping, membership, and pending proposal operations in
  one place so the web panel and Slack command do not duplicate persistence logic.
  """

  import Ecto.Query

  alias Manfrod.Repo
  alias Manfrod.Memory.{ChannelMapping, Project, ProjectMembership}

  def list_projects do
    Repo.all(from p in Project, order_by: [asc: p.slug])
  end

  def create_project(attrs) do
    %Project{}
    |> Project.changeset(attrs)
    |> Repo.insert()
  end

  def update_project(%Project{} = project, attrs) do
    project
    |> Project.changeset(attrs)
    |> Repo.update()
  end

  def delete_project(%Project{} = project), do: Repo.delete(project)

  def list_channel_mappings do
    Repo.all(
      from cm in ChannelMapping, preload: [:project], order_by: [asc: cm.slack_channel_name]
    )
  end

  def create_channel_mapping(attrs) do
    %ChannelMapping{}
    |> ChannelMapping.changeset(attrs)
    |> Repo.insert()
  end

  def update_channel_mapping(%ChannelMapping{} = mapping, attrs) do
    mapping
    |> ChannelMapping.changeset(attrs)
    |> Repo.update()
  end

  def delete_channel_mapping(%ChannelMapping{} = mapping), do: Repo.delete(mapping)

  def list_project_memberships do
    Repo.all(
      from pm in ProjectMembership, preload: [:project, :user], order_by: [asc: pm.project_id]
    )
  end

  def create_project_membership(attrs) do
    %ProjectMembership{}
    |> ProjectMembership.changeset(attrs)
    |> Repo.insert(on_conflict: :nothing, conflict_target: [:user_id, :project_id])
  end

  def delete_project_membership(%ProjectMembership{} = membership), do: Repo.delete(membership)

  def list_pending_proposals do
    Repo.all(
      from cm in ChannelMapping,
        where: cm.status == "pending",
        preload: [:project],
        order_by: [desc: cm.inserted_at]
    )
  end

  def confirm_channel_mapping(mapping_id, attrs \\ %{}) do
    case Repo.get(ChannelMapping, mapping_id) do
      nil ->
        {:error, :not_found}

      mapping ->
        mapping
        |> ChannelMapping.changeset(
          attrs
          |> Map.put(:status, "active")
          |> Map.put_new(:source, "admin_confirmed")
        )
        |> Repo.update()
    end
  end

  def reject_channel_mapping(mapping_id) do
    case Repo.get(ChannelMapping, mapping_id) do
      nil -> {:error, :not_found}
      mapping -> Repo.delete(mapping)
    end
  end
end
