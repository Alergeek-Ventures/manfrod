defmodule Manfrod.Security.SecretWarning do
  @moduledoc false

  require Logger

  alias Manfrod.LLM

  @model "deepseek/deepseek-v4-flash"
  @provider :openrouter

  @system_message """
  You are a Slack bot that just intercepted a message before it reached
  anyone — a local check found what looks like an API key or password in
  it, so the message was withheld: not stored, not forwarded, not shown to
  you or anyone else. You don't get to see its content, and you shouldn't
  claim to know what was in it.

  Write a short, casual Slack message (1-3 sentences) telling the person:
  - their message looked like it contained a secret (API key/token/password),
    so you didn't save or forward it
  - next time, they should paste things like that into
    https://one.d.alergeek.me/ instead of sending them over Slack

  Vary the phrasing naturally each time — don't always use the same
  sentence structure. Match the tone of a normal casual DM from a helpful
  coworker, not a security alert. No quotes around the message, no
  markdown headers.

  The input you get is EITHER a language code (`pl`, `en`, ...) — write
  entirely in that language — OR a few of this person's other recent Slack
  messages, labeled as such. In that case they are only there so you can
  tell which language and tone this person actually writes in; never
  quote, reference, or reply to what they say in them.
  """

  @spec generate(String.t() | nil, atom()) :: String.t()
  def generate(context, fallback_lang) do
    messages = [
      ReqLLM.Context.system(@system_message),
      ReqLLM.Context.user(user_content(context, fallback_lang))
    ]

    case LLM.generate_simple(@model, messages,
           provider: @provider,
           purpose: :secret_warning,
           timeout_ms: 8_000
         ) do
      {:ok, text} when is_binary(text) ->
        clean(text, fallback_lang)

      {:error, reason} ->
        Logger.debug("SecretWarning: LLM error, falling back to fixed text: #{inspect(reason)}")
        fallback(fallback_lang)
    end
  end

  defp user_content(context, _fallback_lang) when is_binary(context) and context != "" do
    "Recent messages from this person, oldest first (language/tone reference only):\n#{context}"
  end

  defp user_content(_context, fallback_lang), do: Atom.to_string(fallback_lang)

  defp clean(text, fallback_lang) do
    case text |> String.trim() |> String.trim("\"") do
      "" -> fallback(fallback_lang)
      cleaned -> cleaned
    end
  end

  defp fallback(:pl) do
    "Hej, ta wiadomość wygląda jakby zawierała klucz API albo hasło — nie zapisałem jej " <>
      "ani nie przekazałem dalej. Wklej takie rzeczy do <https://one.d.alergeek.me/|one.d.alergeek.me> " <>
      "zamiast wysyłać je na Slacku 🔒"
  end

  defp fallback(:en) do
    "Hey, this message looks like it contains an API key or password — I didn't store or " <>
      "forward it. Please paste secrets like that into <https://one.d.alergeek.me/|one.d.alergeek.me> " <>
      "instead of sending them over Slack 🔒"
  end
end
