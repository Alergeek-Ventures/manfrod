defmodule Manfrod.Agent.PlanTitle do
  @moduledoc """
  Names the piece of work the agent is about to do, for the progress card
  shown while it does it ("Sprawdzam rezerwacje biurek", not "List desk
  reservations").

  Generated from the user's request rather than from the tool names, because
  the point of the card's title is to say what the *user* asked for — the
  individual tool calls appear underneath it as steps and speak for
  themselves.

  Runs on the small fast model, off the critical path: the card opens
  immediately with a provisional title taken from the first tool, and is
  renamed when this returns. A failure here costs a nicer label, nothing else.
  """

  require Logger

  alias Manfrod.LLM

  @model "llama-3.1-8b-instant"
  @provider :groq

  # Slack truncates plan titles at 256 characters, but a progress card is read
  # at a glance — anything approaching that is already too long to be useful.
  @max_length 60

  @system_message """
  You name the task an assistant is currently working on, for a progress
  indicator the user watches while they wait.

  Rules:
  - Polish, first person singular, present tense, as the assistant: "Sprawdzam
    rezerwacje biurek", "Szukam notatek ze spotkania", "Przygotowuję
    podsumowanie kanału".
  - 2-5 words, under 60 characters.
  - Describe what is being done for the user, not which tools are used.
  - No quotes, no emoji, no trailing punctuation, no ellipsis.
  - Reply with only the title.
  """

  @doc """
  Generate a title for the work triggered by `request` (the user's message).

  Returns `{:ok, title}`, or `:error` when no usable title could be produced —
  callers should keep whatever provisional label they are already showing
  rather than substituting something worse.
  """
  @spec generate(String.t()) :: {:ok, String.t()} | :error
  def generate(request) when is_binary(request) do
    messages = [
      ReqLLM.Context.system(@system_message),
      ReqLLM.Context.user(trim_request(request))
    ]

    case LLM.generate_simple(@model, messages,
           provider: @provider,
           purpose: :plan_title,
           timeout_ms: 6_000
         ) do
      {:ok, title} when is_binary(title) ->
        clean(title)

      {:error, reason} ->
        Logger.debug("PlanTitle: LLM error, keeping provisional title: #{inspect(reason)}")
        :error
    end
  end

  def generate(_request), do: :error

  # The request can carry injected note context and thread history that dwarf
  # the actual question; only the tail matters for naming the work, and a
  # shorter prompt keeps this call as fast as it needs to be.
  @request_limit 1_000

  defp trim_request(request) do
    if String.length(request) > @request_limit do
      String.slice(request, -@request_limit, @request_limit)
    else
      request
    end
  end

  defp clean(title) do
    cleaned =
      title
      |> String.trim()
      |> String.trim("\"")
      |> String.trim(".")
      |> String.split("\n")
      |> List.first()
      |> to_string()
      |> String.trim()

    cond do
      cleaned == "" -> :error
      String.length(cleaned) > @max_length -> :error
      true -> {:ok, cleaned}
    end
  end
end
