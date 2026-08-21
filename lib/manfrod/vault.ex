defmodule Manfrod.Vault do
  @moduledoc """
  Encryption at rest for secrets that deliberately break from this repo's
  usual plaintext-secret precedent (see `Manfrod.Linear.Connection`).

  Keyed by `LINEAR_ENCRYPTION_KEY` (base64, 32 random bytes — generate via
  `:crypto.strong_rand_bytes(32) |> Base.encode64()`), loaded in
  `config/runtime.exs`. Losing this key makes every value encrypted with it
  permanently undecryptable — there is no recovery path.
  """

  use Cloak.Vault, otp_app: :manfrod
end
