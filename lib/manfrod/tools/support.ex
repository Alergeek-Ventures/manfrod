defmodule Manfrod.Tools.Support do
  @moduledoc """
  Shared helpers for tool implementations under `Manfrod.Tools.*`.
  """

  @doc """
  Identify the inbound Slack message for memory flagging. Only Slack messages
  (map reply_to with a channel, plus a ts) are flaggable; other sources fall
  back to direct writes in the mutating tools.
  """
  def flaggable(%{channel: ch, ts: ts}) when is_binary(ch) and is_binary(ts), do: {:ok, ch, ts}
  def flaggable(_), do: :error
end
