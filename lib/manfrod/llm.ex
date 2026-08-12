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

      # Streaming (same return value, plus incremental text via :on_chunk)
      {:ok, response} =
        Manfrod.LLM.stream_text(messages, tools: tools, on_chunk: &IO.write/1)

      # Access response
      ReqLLM.Response.text(response)
      ReqLLM.Response.tool_calls(response)
      ReqLLM.Response.usage(response)
  """

  alias Manfrod.Events
  alias Manfrod.Pricing

  # Centralized configuration - not configurable per-call
  @timeout_ms 180_000
  @max_retries 3
  @initial_delay_ms 1_000

  # Fallback chain: try each model in order
  # Each tuple: {provider_key, model_id, tier}
  @fallback_chain [
    # {:openrouter, "moonshotai/kimi-k2.5", :paid}
    {:openrouter, "openai/gpt-5.6-luna", :paid},
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
    * `:user_id` - UUID of the user this call is made on behalf of. Attributes
      token spend to a person in the usage analytics; omit for system-wide work.
    * `:session_key` - Session (Slack thread) the call belongs to, for
      per-conversation attribution.

  ## Returns

    * `{:ok, %ReqLLM.Response{}}` - Success with full response including usage
    * `{:error, :all_models_failed}` - All models in fallback chain exhausted
    * `{:error, term()}` - Other error
  """
  @spec generate_text(list(), keyword()) :: {:ok, ReqLLM.Response.t()} | {:error, term()}
  def generate_text(messages, opts \\ []) do
    tools = Keyword.get(opts, :tools, [])
    purpose = Keyword.get(opts, :purpose, :unknown)

    call_with_fallback(messages, tools, purpose, attribution(opts), &do_call/4, @fallback_chain)
  end

  # How much streamed text to accumulate before handing it to `:on_chunk`.
  # Raw provider deltas are a few characters each; forwarding every one of
  # them would put a PubSub broadcast (and a Slack API call downstream) behind
  # every token. ~90 bytes lands a few times per sentence, which reads as
  # continuous typing without flooding anything.
  @chunk_min_bytes 90

  @doc """
  Same contract as `generate_text/2` — including tool calls, the fallback
  chain and usage events — but consumes the response as a stream and hands
  incremental text to `:on_chunk` as it arrives.

  The returned `%ReqLLM.Response{}` is fully materialized, so callers that
  only care about the final result can treat this exactly like
  `generate_text/2`.

  ## Options

  All of `generate_text/2`, plus:

    * `:on_chunk` - 1-arity fun called with each coalesced text fragment, in
      order, in the calling process. Defaults to a no-op.
    * `:chunk_min_bytes` - minimum fragment size handed to `:on_chunk`
      (default `#{@chunk_min_bytes}`). The final fragment of a turn is always
      flushed regardless of size.

  ## Partial output and fallback

  Once a fragment has been handed to `:on_chunk` it has, as far as this
  module is concerned, already been shown to the user. Retrying or falling
  back to another model at that point would replay the answer from the start,
  so a mid-stream failure after the first fragment aborts the whole chain with
  `{:error, :stream_already_emitted}` instead. Failures *before* the first
  fragment retry and fall back exactly like `generate_text/2`.
  """
  @spec stream_text(list(), keyword()) :: {:ok, ReqLLM.Response.t()} | {:error, term()}
  def stream_text(messages, opts \\ []) do
    tools = Keyword.get(opts, :tools, [])
    purpose = Keyword.get(opts, :purpose, :unknown)
    on_chunk = Keyword.get(opts, :on_chunk) || fn _text -> :ok end
    min_bytes = Keyword.get(opts, :chunk_min_bytes, @chunk_min_bytes)

    emitted = :counters.new(1, [])

    invoke = fn messages, tools, provider_key, model_id ->
      if :counters.get(emitted, 1) > 0 do
        {:error, :stream_already_emitted}
      else
        do_stream(messages, tools, provider_key, model_id, on_chunk, min_bytes, emitted)
      end
    end

    stream_with_fallback(messages, tools, purpose, attribution(opts), invoke, @fallback_chain)
  end

  # Top-level Activity fields (not meta) so usage events join to users the same
  # way message/tool events already do.
  defp attribution(opts) do
    %{
      user_id: Keyword.get(opts, :user_id),
      session_key: Keyword.get(opts, :session_key)
    }
  end

  # Merge attribution + source into an event payload.
  defp event(attribution, meta) do
    attribution
    |> Map.put(:source, :llm)
    |> Map.put(:meta, meta)
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
      * `:user_id` - UUID of the user this call is made on behalf of
      * `:session_key` - Session the call belongs to

  ## Returns

    * `{:ok, String.t()}` - The generated text content
    * `{:error, term()}` - Error details
  """
  @spec generate_simple(String.t(), list(), keyword()) :: {:ok, String.t()} | {:error, term()}
  def generate_simple(model_id, messages, opts \\ []) do
    provider_key = Keyword.get(opts, :provider, :openrouter)
    purpose = Keyword.get(opts, :purpose, :simple)
    timeout_ms = Keyword.get(opts, :timeout_ms, 30_000)

    do_generate_simple(
      model_id,
      messages,
      provider_key,
      purpose,
      attribution(opts),
      timeout_ms,
      @simple_max_retries
    )
  end

  defp do_generate_simple(
         model_id,
         messages,
         provider_key,
         purpose,
         attribution,
         timeout_ms,
         retries_left
       ) do
    provider = Map.fetch!(@providers, provider_key)
    api_key = Application.get_env(:manfrod, provider.api_key_config)

    context = ReqLLM.Context.new(messages)
    model = %{id: model_id, provider: :openai}

    attempt = @simple_max_retries - retries_left + 1
    start_time = System.monotonic_time(:millisecond)

    Events.broadcast(
      :llm_call_started,
      event(attribution, %{
        model: model_id,
        provider: provider_key,
        tier: :free,
        purpose: purpose,
        attempt: attempt
      })
    )

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

        Events.broadcast(
          :llm_call_succeeded,
          event(
            attribution,
            usage_meta(model_id, provider_key, :free, purpose, latency_ms, usage)
          )
        )

        {:ok, ReqLLM.Response.text(response)}

      {:error, reason} = error ->
        Events.broadcast(
          :llm_call_failed,
          event(attribution, %{
            model: model_id,
            provider: provider_key,
            tier: :free,
            purpose: purpose,
            attempt: attempt,
            error: format_error(reason),
            latency_ms: latency_ms
          })
        )

        # Retry on retryable errors (429, 5xx, transport errors)
        if retries_left > 1 and retryable_error?(reason) do
          delay_ms = (@simple_initial_delay_ms * :math.pow(2, attempt - 1)) |> trunc()

          Events.broadcast(
            :llm_retry,
            event(attribution, %{
              model: model_id,
              provider: provider_key,
              tier: :free,
              purpose: purpose,
              attempt: attempt,
              delay_ms: delay_ms,
              reason: format_error(reason)
            })
          )

          Process.sleep(delay_ms)

          do_generate_simple(
            model_id,
            messages,
            provider_key,
            purpose,
            attribution,
            timeout_ms,
            retries_left - 1
          )
        else
          error
        end
    end
  end

  # Fallback chain traversal

  defp call_with_fallback(_messages, _tools, _purpose, _attribution, _invoke, []) do
    {:error, :all_models_failed}
  end

  defp call_with_fallback(messages, tools, purpose, attribution, invoke, [
         {provider_key, model_id, tier} | rest
       ]) do
    case call_with_retries(
           messages,
           tools,
           purpose,
           attribution,
           invoke,
           provider_key,
           model_id,
           tier,
           @max_retries
         ) do
      {:ok, _response} = success ->
        success

      {:error, reason} ->
        if rest != [] do
          {next_provider, next_model, _next_tier} = hd(rest)

          Events.broadcast(
            :llm_fallback,
            event(attribution, %{
              from_model: model_id,
              from_provider: provider_key,
              to_model: next_model,
              to_provider: next_provider,
              reason: format_error(reason),
              purpose: purpose
            })
          )
        end

        call_with_fallback(messages, tools, purpose, attribution, invoke, rest)
    end
  end

  # Fallback chain traversal for streaming. Identical to `call_with_fallback/6`
  # except that `:stream_already_emitted` ends the chain immediately — see
  # `stream_text/2` for why a partially streamed answer must never be retried
  # on another model.

  defp stream_with_fallback(_messages, _tools, _purpose, _attribution, _invoke, []) do
    {:error, :all_models_failed}
  end

  defp stream_with_fallback(messages, tools, purpose, attribution, invoke, [
         {provider_key, model_id, tier} | rest
       ]) do
    case call_with_retries(
           messages,
           tools,
           purpose,
           attribution,
           invoke,
           provider_key,
           model_id,
           tier,
           @max_retries
         ) do
      {:ok, _response} = success ->
        success

      {:error, :stream_already_emitted} = aborted ->
        aborted

      {:error, reason} ->
        if rest != [] do
          {next_provider, next_model, _next_tier} = hd(rest)

          Events.broadcast(
            :llm_fallback,
            event(attribution, %{
              from_model: model_id,
              from_provider: provider_key,
              to_model: next_model,
              to_provider: next_provider,
              reason: format_error(reason),
              purpose: purpose
            })
          )
        end

        stream_with_fallback(messages, tools, purpose, attribution, invoke, rest)
    end
  end

  # Retry loop with exponential backoff

  defp call_with_retries(
         messages,
         tools,
         purpose,
         attribution,
         invoke,
         provider_key,
         model_id,
         tier,
         retries_left
       ) do
    attempt = @max_retries - retries_left + 1

    Events.broadcast(
      :llm_call_started,
      event(attribution, %{
        model: model_id,
        provider: provider_key,
        tier: tier,
        purpose: purpose,
        attempt: attempt
      })
    )

    start_time = System.monotonic_time(:millisecond)

    case invoke.(messages, tools, provider_key, model_id) do
      {:ok, response} ->
        latency_ms = System.monotonic_time(:millisecond) - start_time
        usage = ReqLLM.Response.usage(response) || %{}

        Events.broadcast(
          :llm_call_succeeded,
          event(attribution, usage_meta(model_id, provider_key, tier, purpose, latency_ms, usage))
        )

        {:ok, response}

      {:error, reason} = error ->
        latency_ms = System.monotonic_time(:millisecond) - start_time

        Events.broadcast(
          :llm_call_failed,
          event(attribution, %{
            model: model_id,
            provider: provider_key,
            tier: tier,
            purpose: purpose,
            attempt: attempt,
            error: format_error(reason),
            latency_ms: latency_ms
          })
        )

        if retries_left > 1 and retryable_error?(reason) do
          delay_ms = calculate_delay(attempt)

          Events.broadcast(
            :llm_retry,
            event(attribution, %{
              model: model_id,
              provider: provider_key,
              tier: tier,
              purpose: purpose,
              attempt: attempt,
              delay_ms: delay_ms,
              reason: format_error(reason)
            })
          )

          Process.sleep(delay_ms)

          call_with_retries(
            messages,
            tools,
            purpose,
            attribution,
            invoke,
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
    {model, opts} = request(tools, provider_key, model_id)

    case ReqLLM.generate_text(model, ReqLLM.Context.new(messages), opts) do
      {:ok, response} = success ->
        # A text-only call (no tools) that comes back with a blank body is a
        # dead response, not a usable one — some models occasionally return
        # empty content instead of an HTTP error. Surface it as a retryable
        # error so the existing retry/fallback chain kicks in instead of the
        # caller silently getting nothing back. Tool-calling responses can
        # legitimately have blank text alongside tool_calls, so this only
        # applies when no tools were requested.
        if tools == [] and blank?(ReqLLM.Response.text(response)) do
          {:error, :empty_response}
        else
          success
        end

      error ->
        error
    end
  end

  defp blank?(nil), do: true
  defp blank?(text), do: String.trim(text) == ""

  # Streaming variant of `do_call/4`. `ReqLLM.StreamResponse.process_stream/2`
  # consumes the stream exactly once, firing `on_result` per provider delta
  # while collecting the chunks it needs to build the same materialized
  # `%ReqLLM.Response{}` (tool calls and usage included) that the non-streaming
  # path returns.
  defp do_stream(messages, tools, provider_key, model_id, on_chunk, min_bytes, emitted) do
    {model, opts} = request(tools, provider_key, model_id)

    case ReqLLM.stream_text(model, ReqLLM.Context.new(messages), opts) do
      {:ok, stream_response} ->
        # Deltas are coalesced across callbacks, and the callback runs in this
        # process, so the buffer lives in the process dictionary under a key
        # unique to this call rather than in a separate process.
        buffer_key = {__MODULE__, :stream_buffer, make_ref()}
        Process.put(buffer_key, "")

        result =
          ReqLLM.StreamResponse.process_stream(stream_response,
            on_result: fn text ->
              buffer = Process.get(buffer_key) <> text

              if byte_size(buffer) >= min_bytes do
                Process.put(buffer_key, "")
                emit_chunk(buffer, on_chunk, emitted)
              else
                Process.put(buffer_key, buffer)
              end
            end
          )

        # Whatever is left is the tail of the turn — always flushed, however
        # short, or the last sentence of every answer would go missing.
        case Process.delete(buffer_key) do
          "" -> :ok
          tail -> emit_chunk(tail, on_chunk, emitted)
        end

        result

      {:error, reason} ->
        {:error, reason}
    end
  end

  defp emit_chunk(text, on_chunk, emitted) do
    :counters.add(emitted, 1, 1)
    on_chunk.(text)
  end

  defp request(tools, provider_key, model_id) do
    provider = Map.fetch!(@providers, provider_key)
    api_key = Application.get_env(:manfrod, provider.api_key_config)

    opts =
      [
        base_url: provider.base_url,
        api_key: api_key,
        receive_timeout: @timeout_ms,
        req_http_options: [retry: false]
      ]
      |> maybe_add_tools(tools)

    {%{id: model_id, provider: :openai}, opts}
  end

  defp maybe_add_tools(opts, []), do: opts
  defp maybe_add_tools(opts, tools), do: Keyword.put(opts, :tools, tools)

  # Helpers

  # Usage meta for a succeeded call. `cost_usd` is stamped here, at the price
  # in effect when the call was made, so re-pricing a model later never
  # rewrites the cost of calls already billed at the old rate.
  defp usage_meta(model_id, provider_key, tier, purpose, latency_ms, usage) do
    tokens = %{
      input_tokens: usage[:input_tokens] || 0,
      output_tokens: usage[:output_tokens] || 0,
      cached_tokens: usage[:cached_tokens] || 0,
      cache_creation_tokens: usage[:cache_creation_tokens] || 0
    }

    %{
      model: model_id,
      provider: provider_key,
      tier: tier,
      purpose: purpose,
      latency_ms: latency_ms,
      total_tokens: usage[:total_tokens],
      cost_usd: Pricing.cost(model_id, tokens)
    }
    |> Map.merge(tokens)
  end

  defp calculate_delay(attempt) do
    (@initial_delay_ms * :math.pow(2, attempt - 1)) |> trunc()
  end

  defp retryable_error?(%{status: status}) when status in [429, 500, 502, 503, 504], do: true
  defp retryable_error?(%Req.TransportError{}), do: true
  defp retryable_error?(%Mint.TransportError{}), do: true
  defp retryable_error?(:timeout), do: true
  defp retryable_error?({:timeout, _}), do: true
  defp retryable_error?(:empty_response), do: true
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
  defp format_error(:empty_response), do: "Model returned an empty response"
  defp format_error(other), do: inspect(other)
end
