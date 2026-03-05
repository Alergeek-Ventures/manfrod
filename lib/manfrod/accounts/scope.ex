defmodule Manfrod.Accounts.Scope do
  @moduledoc """
  Defines the scope of the caller to be used throughout the app.

  The `Scope` is created after login and kept in the session as
  `current_scope`. It is passed to LiveViews via `<Layouts.app>` and
  through `on_mount` hooks.

  In Phoenix 1.8, `current_scope` replaces the older `current_user`
  pattern — it wraps the user identity and can be extended with
  additional context (e.g. selected workspace, role) in the future.
  """

  alias Manfrod.Accounts.User

  defstruct [:user]

  @type t :: %__MODULE__{user: User.t()}

  @doc """
  Creates a scope for the given user.
  """
  def for_user(%User{} = user) do
    %__MODULE__{user: user}
  end
end
