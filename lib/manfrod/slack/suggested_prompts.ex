defmodule Manfrod.Slack.SuggestedPrompts do
  @moduledoc """
  The up-to-four starter prompts pinned to the top of a new agent thread.

  Slack shows these before the user has typed anything, which makes them the
  main place people discover what the bot can actually do — so they are built
  from that person's current situation rather than from a fixed list. Someone
  with a desk booked tomorrow is offered a way to cancel it; someone with none
  is offered a way to book one.

  Deliberately cheap: a couple of indexed reads, no LLM call and no Slack API
  call. This runs while the user is staring at an empty thread, and a slow
  suggestion is worse than a generic one.
  """

  require Logger

  alias Manfrod.Desks
  alias Manfrod.Slack.UserContext

  @max_prompts 4

  @doc """
  Build the prompt list for `user` (a `Manfrod.Accounts.User`, or nil for
  someone the bot has never seen).

  `resolve_channel_name` is used to name the channel the person is currently
  looking at, if any — see `Manfrod.Slack.UserContext.describe/2`.
  """
  @spec build(map() | nil, String.t() | nil, (String.t() -> String.t() | nil)) :: [map()]
  def build(user, slack_user_id \\ nil, resolve_channel_name \\ fn _ -> nil end) do
    (contextual(user, slack_user_id, resolve_channel_name) ++ defaults())
    |> Enum.uniq_by(& &1.title)
    |> Enum.take(@max_prompts)
  end

  # Situation-specific prompts, most specific first.
  defp contextual(user, slack_user_id, resolve_channel_name) do
    [
      current_channel_prompt(slack_user_id, resolve_channel_name),
      desk_prompt(user)
    ]
    |> Enum.reject(&is_nil/1)
  end

  # What the user was reading a moment ago is usually what they came to ask
  # about — this is the prompt that turns app_context_changed into something
  # visible.
  defp current_channel_prompt(nil, _resolve_channel_name), do: nil

  defp current_channel_prompt(slack_user_id, resolve_channel_name) do
    with app_context when is_map(app_context) <- UserContext.get(slack_user_id),
         channel_id when is_binary(channel_id) <- app_context["channel_id"],
         false <- String.starts_with?(channel_id, "D"),
         name when is_binary(name) <- resolve_channel_name.(channel_id) do
      %{
        title: "Streść ##{name}",
        message: "Streść mi, co działo się na ##{name} w ciągu ostatniej doby."
      }
    else
      _ -> nil
    end
  end

  defp desk_prompt(nil), do: nil

  defp desk_prompt(user) do
    case upcoming_reservations(user.id) do
      [reservation | _] ->
        %{
          title: "Odwołaj biurko",
          message: "Odwołaj moją rezerwację biurka na #{reservation.date}."
        }

      [] ->
        %{
          title: "Zarezerwuj biurko",
          message: "Zarezerwuj mi biurko na jutro."
        }
    end
  end

  # A booking lookup must never be the reason a thread opens without any
  # prompts at all — on any failure the generic set still goes out.
  defp upcoming_reservations(user_id) do
    Desks.list_user_reservations(user_id)
  rescue
    error ->
      Logger.warning("SuggestedPrompts: desk lookup failed: #{Exception.message(error)}")
      []
  end

  # Padding, in rough order of how often people actually want them.
  defp defaults do
    [
      %{
        title: "Co mam na dziś?",
        message: "Co mam dziś zaplanowane? Przypomnienia, spotkania, rezerwacje."
      },
      %{
        title: "Zgłoś urlop",
        message: "Chcę zgłosić urlop - "
      },
      %{
        title: "Kto jest nieobecny?",
        message: "Kto z zespołu jest nieobecny w tym tygodniu?"
      },
      %{
        title: "Przypomnij mi",
        message: "Przypomnij mi jutro rano o "
      }
    ]
  end
end
