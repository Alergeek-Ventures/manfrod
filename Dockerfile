FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

FROM base AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates fontconfig fonts-dejavu-core \
  && rm -rf /var/lib/apt/lists/* \
  && fc-cache -f
ENV NODE_ENV=production PORT=35233 XDG_CACHE_HOME=/tmp
COPY --from=build /app /app
RUN mkdir -p /app/.eve/.workflow-data && chown -R node:node /app/.eve
USER node
EXPOSE 35233
CMD ["sh", "-c", "node scripts/migrate.mjs && exec node_modules/.bin/next start --port ${PORT}"]
