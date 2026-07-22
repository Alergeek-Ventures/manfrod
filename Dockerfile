# Builds a Mix release for production (used for Coolify / Docker deployments).
#
#   - https://hub.docker.com/r/hexpm/elixir/tags - for the build image
#   - https://hub.docker.com/_/debian/tags?name=bookworm-slim - for the release image
#
ARG ELIXIR_VERSION=1.18.4
ARG OTP_VERSION=28.2
ARG DEBIAN_VERSION=bookworm-20260610

ARG BUILDER_IMAGE="docker.io/hexpm/elixir:${ELIXIR_VERSION}-erlang-${OTP_VERSION}-debian-${DEBIAN_VERSION}-slim"
ARG RUNNER_IMAGE="docker.io/debian:${DEBIAN_VERSION}-slim"

FROM ${BUILDER_IMAGE} AS builder

RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential git libvips-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

RUN mix local.hex --force \
  && mix local.rebar --force

ENV MIX_ENV="prod"

COPY mix.exs mix.lock ./
RUN mix deps.get --only $MIX_ENV
RUN mkdir config

# Copy compile-time config before compiling deps so config changes bust cache.
COPY config/config.exs config/
RUN mix deps.compile

RUN mix assets.setup

COPY priv priv
COPY lib lib
COPY assets assets

RUN mix assets.deploy

RUN mix compile

# Changes to config/runtime.exs don't require recompiling the code.
COPY config/runtime.exs config/

COPY rel rel
RUN mix release

FROM ${RUNNER_IMAGE} AS final

# fontconfig + a font are needed for Manfrod.DeskMap's text rendering
# (Image.Text.text, via libvips/Pango) — without them every glyph falls
# back to a "notdef" tofu box, even for plain ASCII. DejaVu Sans covers
# Polish diacritics too.
RUN apt-get update \
  && apt-get install -y --no-install-recommends libstdc++6 openssl libncurses6 locales ca-certificates fontconfig fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/*

# Pre-build the fontconfig cache as root — the release runs as `nobody`,
# which can't write a cache of its own, so without this every text render
# re-scans fonts from scratch (and fontconfig logs a "no writable cache
# directories" warning on every call).
RUN fc-cache -f

RUN sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen \
  && locale-gen

ENV LANG=en_US.UTF-8
ENV LANGUAGE=en_US:en
ENV LC_ALL=en_US.UTF-8

# fontconfig also wants a per-user cache dir; `nobody` has no home
# directory, so point it at /tmp (world-writable) instead of silently
# failing to write on every text render.
ENV XDG_CACHE_HOME=/tmp

WORKDIR "/app"
RUN chown nobody /app

ENV MIX_ENV="prod"

COPY --from=builder --chown=nobody:root /app/_build/${MIX_ENV}/rel/manfrod ./

USER nobody

EXPOSE 35233

# Runs pending Ecto migrations, then starts the release.
ENTRYPOINT ["/app/bin/entrypoint"]
