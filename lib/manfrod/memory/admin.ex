defmodule Manfrod.Memory.Admin do
  @moduledoc """
  Channel mapping persistence used by the Slack channel-detection flow.
  """

  alias Manfrod.Repo
  alias Manfrod.Memory.ChannelMapping

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
end
