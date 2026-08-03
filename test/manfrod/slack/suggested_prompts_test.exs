defmodule Manfrod.Slack.SuggestedPromptsTest do
  use Manfrod.DataCase

  alias Manfrod.Desks
  alias Manfrod.Slack.SuggestedPrompts

  @moduletag :db

  defp titles(prompts), do: Enum.map(prompts, & &1.title)

  test "an unknown user still gets a full set of generic prompts" do
    prompts = SuggestedPrompts.build(nil)

    assert length(prompts) == 4
    assert Enum.all?(prompts, &match?(%{title: t, message: m} when t != "" and m != "", &1))
  end

  describe "with a known user" do
    setup do
      %{user: insert_user!()}
    end

    test "offers to book a desk when they have none coming up", %{user: user} do
      assert "Zarezerwuj biurko" in titles(SuggestedPrompts.build(user))
    end

    test "offers to cancel instead once a desk is booked", %{user: user} do
      desk = insert_desk!(%{label: "SP-#{System.unique_integer([:positive])}"})
      date = Date.add(Date.utc_today(), 1)

      {:ok, _reservation} = Desks.reserve_desk(desk.label, user.id, date)

      prompts = SuggestedPrompts.build(user)

      assert "Odwołaj biurko" in titles(prompts)
      refute "Zarezerwuj biurko" in titles(prompts)
      assert Enum.find(prompts, &(&1.title == "Odwołaj biurko")).message =~ to_string(date)
    end

    # Slack drops anything past the fourth prompt, so trimming has to happen
    # here — otherwise a contextual prompt silently loses to a generic one.
    test "never returns more than Slack will show", %{user: user} do
      assert length(SuggestedPrompts.build(user)) == 4
    end
  end
end
