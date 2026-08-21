defmodule Manfrod.Encrypted.Binary do
  @moduledoc "Ecto type for AES-GCM-encrypted binary fields, backed by `Manfrod.Vault`."

  use Cloak.Ecto.Binary, vault: Manfrod.Vault
end
