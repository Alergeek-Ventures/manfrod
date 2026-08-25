defmodule Manfrod.AnalyticsTest do
  use Manfrod.DataCase, async: false

  alias Manfrod.Analytics
  alias Manfrod.Analytics.Rollup
  alias Manfrod.Analytics.ToolRollup
  alias Manfrod.Analytics.UsageRollup
  alias Manfrod.Events.Activity
  alias Manfrod.Events.Store

  @gpt "openai/gpt-5.6-luna"
  @deepseek "deepseek/deepseek-v4-flash"

  defp record(type, attrs) do
    activity = Activity.new(type, attrs)
    {:ok, _} = Store.insert(activity)
    activity
  end

  defp llm_success(user_id, model, tokens, extra \\ %{}) do
    meta =
      Map.merge(
        %{
          model: model,
          provider: :openrouter,
          tier: :paid,
          purpose: :agent,
          latency_ms: 1000
        },
        Map.merge(tokens, extra)
      )

    record(:llm_call_succeeded, %{source: :llm, user_id: user_id, meta: meta})
  end

  describe "rollup" do
    test "aggregates calls and prices tokens per user, model, and purpose" do
      user = insert_user!()

      llm_success(user.id, @gpt, %{input_tokens: 1_000_000, output_tokens: 100_000})
      llm_success(user.id, @gpt, %{input_tokens: 1_000_000, output_tokens: 100_000})

      Rollup.run_for_date(Date.utc_today())

      [row] = Repo.all(from r in UsageRollup, where: r.model == ^@gpt)

      assert row.calls == 2
      assert row.input_tokens == 2_000_000
      assert row.output_tokens == 200_000
      assert row.user_id == user.id
      assert row.purpose == "agent"
      # 2M input @ $0.20 + 200K output @ $1.20 = $0.64
      assert Decimal.eq?(Decimal.round(row.cost_usd, 4), Decimal.new("0.6400"))
    end

    test "separates rows per model so a mid-window switch stays distinguishable" do
      user = insert_user!()

      llm_success(user.id, @deepseek, %{input_tokens: 1_000_000, output_tokens: 0})
      llm_success(user.id, @gpt, %{input_tokens: 1_000_000, output_tokens: 0})

      Rollup.run_for_date(Date.utc_today())

      rows = Repo.all(UsageRollup) |> Map.new(&{&1.model, &1})

      assert map_size(rows) == 2
      assert rows[@deepseek].calls == 1
      assert rows[@gpt].calls == 1
      # DeepSeek input is cheaper, so its row must cost less for equal tokens
      assert Decimal.lt?(rows[@deepseek].cost_usd, rows[@gpt].cost_usd)
    end

    test "is idempotent — rerunning a day replaces rather than doubles" do
      user = insert_user!()
      llm_success(user.id, @gpt, %{input_tokens: 500_000, output_tokens: 0})

      Rollup.run_for_date(Date.utc_today())
      Rollup.run_for_date(Date.utc_today())
      Rollup.run_for_date(Date.utc_today())

      [row] = Repo.all(UsageRollup)
      assert row.calls == 1
      assert row.input_tokens == 500_000
    end

    test "prefers the cost stamped on the event over re-pricing it" do
      user = insert_user!()

      llm_success(
        user.id,
        @gpt,
        %{input_tokens: 1_000_000, output_tokens: 0},
        %{cost_usd: 99.0}
      )

      Rollup.run_for_date(Date.utc_today())

      [row] = Repo.all(UsageRollup)
      assert Decimal.eq?(Decimal.round(row.cost_usd, 2), Decimal.new("99.00"))
    end

    test "keeps unattributed system calls with a null user rather than dropping them" do
      llm_success(nil, @gpt, %{input_tokens: 1_000_000, output_tokens: 0})

      Rollup.run_for_date(Date.utc_today())

      [row] = Repo.all(UsageRollup)
      assert row.user_id == nil
      assert row.calls == 1
    end

    test "counts failures, retries, and fallbacks alongside successful calls" do
      user = insert_user!()
      base = %{model: @gpt, provider: :openrouter, tier: :paid, purpose: :agent}

      llm_success(user.id, @gpt, %{input_tokens: 100, output_tokens: 10})
      record(:llm_call_failed, %{source: :llm, user_id: user.id, meta: base})
      record(:llm_retry, %{source: :llm, user_id: user.id, meta: base})

      Rollup.run_for_date(Date.utc_today())

      [row] = Repo.all(UsageRollup)
      assert row.calls == 1
      assert row.failed_calls == 1
      assert row.retries == 1
    end

    test "counts action_started events per tool, across users" do
      user = insert_user!()
      other = insert_user!()

      record(:action_started, %{source: :agent, user_id: user.id, meta: %{action: "reserve_desk"}})

      record(:action_started, %{
        source: :agent,
        user_id: other.id,
        meta: %{action: "reserve_desk"}
      })

      record(:action_started, %{source: :agent, user_id: user.id, meta: %{action: "search_notes"}})

      Rollup.run_for_date(Date.utc_today())

      rows = Repo.all(ToolRollup) |> Map.new(&{&1.tool, &1.calls})

      assert rows["reserve_desk"] == 2
      assert rows["search_notes"] == 1
    end
  end

  describe "adoption" do
    test "counts a person active from their interactions and ignores never-users" do
      active = insert_user!(%{name: "Active"})
      _idle = insert_user!(%{name: "Idle"})

      record(:message_received, %{source: :slack, user_id: active.id, meta: %{content: "hi"}})
      record(:responding, %{source: :slack, user_id: active.id, meta: %{content: "hello"}})

      Rollup.run_for_date(Date.utc_today())

      adoption = Analytics.adoption(7)

      assert adoption.active_users == 1
      assert adoption.total_people == 2
      assert adoption.never_used == 1
      assert adoption.reach == 50.0
    end

    test "excludes system service accounts from adoption but keeps their spend" do
      person = insert_user!(%{name: "Person"})

      system =
        insert_user!(%{
          name: "Retrospector",
          slack_id: "system:retrospector-#{:rand.uniform(999)}"
        })

      record(:message_received, %{source: :slack, user_id: person.id, meta: %{content: "hi"}})
      record(:message_received, %{source: :slack, user_id: system.id, meta: %{content: "sys"}})
      llm_success(system.id, @gpt, %{input_tokens: 1_000_000, output_tokens: 0})

      Rollup.run_for_date(Date.utc_today())

      adoption = Analytics.adoption(7)
      summary = Analytics.summary(7)

      assert adoption.active_users == 1, "system account must not count as an adopting person"
      assert Decimal.gt?(summary.cost_usd, Decimal.new(0)), "system spend is still real money"
    end

    test "per-user rows flag spend that predates cost attribution" do
      user = insert_user!(%{name: "Legacy"})

      # Activity, but no attributed LLM call — the pre-instrumentation shape.
      record(:message_received, %{source: :slack, user_id: user.id, meta: %{content: "hi"}})

      Rollup.run_for_date(Date.utc_today())

      [row] = Analytics.by_user(7)

      assert row.messages_received == 1
      assert row.attributed? == false
      assert Decimal.eq?(row.cost_usd, Decimal.new(0))
    end
  end

  describe "summary" do
    test "reports cache savings as the gap against uncached pricing" do
      user = insert_user!()

      llm_success(user.id, @gpt, %{
        input_tokens: 1_000_000,
        output_tokens: 0,
        cached_tokens: 900_000
      })

      Rollup.run_for_date(Date.utc_today())

      summary = Analytics.summary(7)

      assert summary.cache_hit_rate == 90.0
      assert Decimal.gt?(summary.cache_savings_usd, Decimal.new(0))
      assert Decimal.lt?(summary.cost_usd, summary.uncached_cost_usd)
    end

    test "daily series covers every day in the window with no gaps" do
      series = Analytics.daily_series(14)

      assert length(series) == 14
      assert List.last(series).date == Date.utc_today()
    end
  end

  describe "by_tool" do
    test "splits tools into everyday reads and user-intent actions" do
      user = insert_user!()

      record(:action_started, %{source: :agent, user_id: user.id, meta: %{action: "reserve_desk"}})

      record(:action_started, %{source: :agent, user_id: user.id, meta: %{action: "reserve_desk"}})

      record(:action_started, %{source: :agent, user_id: user.id, meta: %{action: "search_notes"}})

      Rollup.run_for_date(Date.utc_today())

      result = Analytics.by_tool(7)

      assert %{tool: "reserve_desk", calls: 2, category: :intent} =
               Enum.find(result.intent, &(&1.tool == "reserve_desk"))

      assert %{tool: "search_notes", calls: 1, category: :everyday} =
               Enum.find(result.everyday, &(&1.tool == "search_notes"))

      assert result.total_calls == 3
    end
  end
end
