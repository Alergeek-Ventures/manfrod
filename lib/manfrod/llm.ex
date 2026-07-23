defmodule Manfrod.LLM do
  @moduledoc """
  Centralized LLM client with fallback chain and event emission.

  Provides a unified interface for all LLM calls in the application with:
  - Automatic fallback across providers (zen free → openrouter free → zen paid)
  - Retry logic with exponential backoff
  - Event emission for observability (retries, fallbacks, success, failure)
  - Token tracking

  ## Configuration

  All retry and timeout behavior is controlled centrally:
  - 180s timeout per request
  - 3 retries per model with exponential backoff (1s, 2s, 4s)
  - Fallback chain traverses all configured models before failing

  ## Usage

      # Simple call (extractor style)
      {:ok, response} = Manfrod.LLM.generate_text(messages, purpose: :extractor)

      # With tools (agent style)
      {:ok, response} = Manfrod.LLM.generate_text(messages, tools: tools, purpose: :agent)

      # Access response
      ReqLLM.Response.text(response)
      ReqLLM.Response.tool_calls(response)
      ReqLLM.Response.usage(response)
  """

  alias Manfrod.Events

  # Centralized configuration - not configurable per-call
  @timeout_ms 180_000
  @max_retries 3
  @initial_delay_ms 1_000

  # Fallback chain: try each model in order
  # Each tuple: {provider_key, model_id, tier}
  @fallback_chain [
    # {:openrouter, "moonshotai/kimi-k2.5", :paid}
    {:openrouter, "deepseek/deepseek-v4-flash", :paid}
  ]

  # Provider configuration
  @providers %{
    zen: %{
      base_url: "https://opencode.ai/zen/v1",
      api_key_config: :zen_api_key
    },
    openrouter: %{
      base_url: "https://openrouter.ai/api/v1",
      api_key_config: :openrouter_api_key
    },
    groq: %{
      base_url: "https://api.groq.com/openai/v1",
      api_key_config: :groq_api_key
    }
  }

  @doc """
  Generate text using the LLM with automatic fallback and retry.

  ## Options

    * `:tools` - List of `ReqLLM.Tool` structs for tool-calling
    * `:purpose` - Atom identifying the caller (:agent, :extractor, :retrospector)
      Used for event metadata only.

  ## Returns

    * `{:ok, %ReqLLM.Response{}}` - Success with full response including usage
    * `{:error, :all_models_failed}` - All models in fallback chain exhausted
    * `{:error, term()}` - Other error
  """
  @spec generate_text(list(), keyword()) :: {:ok, ReqLLM.Response.t()} | {:error, term()}
  def generate_text(messages, opts \\ []) do
    tools = Keyword.get(opts, :tools, [])
    purpose = Keyword.get(opts, :purpose, :unknown)

    call_with_fallback(messages, tools, purpose, @fallback_chain)
  end

  # Simple call retry config
  @simple_max_retries 3
  @simple_initial_delay_ms 500

  @doc """
  Direct call to a specific model without fallback chain.

  Useful for lightweight, fast calls where fallback is not needed (e.g., query expansion).
  Uses shorter timeout (30s) and retries on 429/5xx errors with exponential backoff.

  ## Arguments

    * `model_id` - The model identifier (e.g., "liquid/lfm-2.5-1.2b-instruct:free")
    * `messages` - List of message maps with :role and :content
    * `opts` - Options:
      * `:provider` - Provider key (:openrouter or :zen), defaults to :openrouter
      * `:purpose` - Atom for telemetry (defaults to :simple)
      * `:timeout_ms` - Request timeout in ms (defaults to 30_000)

  ## Returns

    * `{:ok, String.t()}` - The generated text content
    * `{:error, term()}` - Error details
  """
  @spec generate_simple(String.t(), list(), keyword()) :: {:ok, String.t()} | {:error, term()}
  def generate_simple(model_id, messages, opts \\ []) do
    provider_key = Keyword.get(opts, :provider, :openrouter)
    purpose = Keyword.get(opts, :purpose, :simple)
    timeout_ms = Keyword.get(opts, :timeout_ms, 30_000)

    do_generate_simple(model_id, messages, provider_key, purpose, timeout_ms, @simple_max_retries)
  end

  defp do_generate_simple(model_id, messages, provider_key, purpose, timeout_ms, retries_left) do
    provider = Map.fetch!(@providers, provider_key)
    api_key = Application.get_env(:manfrod, provider.api_key_config)

    context = ReqLLM.Context.new(messages)
    model = %{id: model_id, provider: :openai}

    attempt = @simple_max_retries - retries_left + 1
    start_time = System.monotonic_time(:millisecond)

    Events.broadcast(:llm_call_started, %{
      source: :llm,
      meta: %{
        model: model_id,
        provider: provider_key,
        tier: :free,
        purpose: purpose,
        attempt: attempt
      }
    })

    result =
      ReqLLM.generate_text(model, context,
        base_url: provider.base_url,
        api_key: api_key,
        receive_timeout: timeout_ms,
        req_http_options: [retry: false]
      )

    latency_ms = System.monotonic_time(:millisecond) - start_time

    case result do
      {:ok, response} ->
        usage = ReqLLM.Response.usage(response) || %{}

        Events.broadcast(:llm_call_succeeded, %{
          source: :llm,
          meta: %{
            model: model_id,
            provider: provider_key,
            tier: :free,
            purpose: purpose,
            latency_ms: latency_ms,
            input_tokens: usage[:input_tokens],
            output_tokens: usage[:output_tokens],
            total_tokens: usage[:total_tokens],
            cached_tokens: usage[:cached_tokens],
            cache_creation_tokens: usage[:cache_creation_tokens]
          }
        })

        {:ok, ReqLLM.Response.text(response)}

      {:error, reason} = error ->
        Events.broadcast(:llm_call_failed, %{
          source: :llm,
          meta: %{
            model: model_id,
            provider: provider_key,
            tier: :free,
            purpose: purpose,
            attempt: attempt,
            error: format_error(reason),
            latency_ms: latency_ms
          }
        })

        # Retry on retryable errors (429, 5xx, transport errors)
        if retries_left > 1 and retryable_error?(reason) do
          delay_ms = (@simple_initial_delay_ms * :math.pow(2, attempt - 1)) |> trunc()

          Events.broadcast(:llm_retry, %{
            source: :llm,
            meta: %{
              model: model_id,
              provider: provider_key,
              tier: :free,
              purpose: purpose,
              attempt: attempt,
              delay_ms: delay_ms,
              reason: format_error(reason)
            }
          })

          Process.sleep(delay_ms)

          do_generate_simple(
            model_id,
            messages,
            provider_key,
            purpose,
            timeout_ms,
            retries_left - 1
          )
        else
          error
        end
    end
  end

  # Fallback chain traversal

  defp call_with_fallback(_messages, _tools, _purpose, []) do
    {:error, :all_models_failed}
  end

  defp call_with_fallback(messages, tools, purpose, [{provider_key, model_id, tier} | rest]) do
    case call_with_retries(messages, tools, purpose, provider_key, model_id, tier, @max_retries) do
      {:ok, _response} = success ->
        success

      {:error, reason} ->
        if rest != [] do
          {next_provider, next_model, _next_tier} = hd(rest)

          Events.broadcast(:llm_fallback, %{
            source: :llm,
            meta: %{
              from_model: model_id,
              from_provider: provider_key,
              to_model: next_model,
              to_provider: next_provider,
              reason: format_error(reason),
              purpose: purpose
            }
          })
        end

        call_with_fallback(messages, tools, purpose, rest)
    end
  end

  # Retry loop with exponential backoff

  defp call_with_retries(messages, tools, purpose, provider_key, model_id, tier, retries_left) do
    attempt = @max_retries - retries_left + 1

    Events.broadcast(:llm_call_started, %{
      source: :llm,
      meta: %{
        model: model_id,
        provider: provider_key,
        tier: tier,
        purpose: purpose,
        attempt: attempt
      }
    })

    start_time = System.monotonic_time(:millisecond)

    case do_call(messages, tools, provider_key, model_id) do
      {:ok, response} ->
        latency_ms = System.monotonic_time(:millisecond) - start_time
        usage = ReqLLM.Response.usage(response) || %{}

        Events.broadcast(:llm_call_succeeded, %{
          source: :llm,
          meta: %{
            model: model_id,
            provider: provider_key,
            tier: tier,
            purpose: purpose,
            latency_ms: latency_ms,
            input_tokens: usage[:input_tokens],
            output_tokens: usage[:output_tokens],
            total_tokens: usage[:total_tokens],
            cached_tokens: usage[:cached_tokens],
            cache_creation_tokens: usage[:cache_creation_tokens]
          }
        })

        {:ok, response}

      {:error, reason} = error ->
        latency_ms = System.monotonic_time(:millisecond) - start_time

        Events.broadcast(:llm_call_failed, %{
          source: :llm,
          meta: %{
            model: model_id,
            provider: provider_key,
            tier: tier,
            purpose: purpose,
            attempt: attempt,
            error: format_error(reason),
            latency_ms: latency_ms
          }
        })

        if retries_left > 1 and retryable_error?(reason) do
          delay_ms = calculate_delay(attempt)

          Events.broadcast(:llm_retry, %{
            source: :llm,
            meta: %{
              model: model_id,
              provider: provider_key,
              tier: tier,
              purpose: purpose,
              attempt: attempt,
              delay_ms: delay_ms,
              reason: format_error(reason)
            }
          })

          Process.sleep(delay_ms)

          call_with_retries(
            messages,
            tools,
            purpose,
            provider_key,
            model_id,
            tier,
            retries_left - 1
          )
        else
          error
        end
    end
  end

  # Actual LLM call

  defp do_call(messages, tools, provider_key, model_id) do
    provider = Map.fetch!(@providers, provider_key)
    api_key = Application.get_env(:manfrod, provider.api_key_config)

    context = ReqLLM.Context.new(messages)
    model = %{id: model_id, provider: :openai}

    opts =
      [
        base_url: provider.base_url,
        api_key: api_key,
        receive_timeout: @timeout_ms,
        req_http_options: [retry: false]
      ]
      |> maybe_add_tools(tools)

    ReqLLM.generate_text(model, context, opts)
  end

  defp maybe_add_tools(opts, []), do: opts
  defp maybe_add_tools(opts, tools), do: Keyword.put(opts, :tools, tools)

  # Helpers

  defp calculate_delay(attempt) do
    (@initial_delay_ms * :math.pow(2, attempt - 1)) |> trunc()
  end

  defp retryable_error?(%{status: status}) when status in [429, 500, 502, 503, 504], do: true
  defp retryable_error?(%Req.TransportError{}), do: true
  defp retryable_error?(%Mint.TransportError{}), do: true
  defp retryable_error?(:timeout), do: true
  defp retryable_error?({:timeout, _}), do: true
  defp retryable_error?(_), do: false

  defp format_error(%{status: status, body: body}) when is_map(body) do
    message = body["error"]["message"] || body["message"] || inspect(body)
    "HTTP #{status}: #{message}"
  end

  defp format_error(%{status: status}) do
    "HTTP #{status}"
  end

  defp format_error(%Req.TransportError{reason: reason}) do
    "Transport error: #{inspect(reason)}"
  end

  defp format_error(%Mint.TransportError{reason: reason}) do
    "Transport error: #{inspect(reason)}"
  end

  defp format_error(:timeout), do: "Request timeout"
  defp format_error({:timeout, _}), do: "Request timeout"
  defp format_error(other), do: inspect(other)
end
