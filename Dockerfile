# syntax=docker/dockerfile:1
# can-database — the aeronautical data console. Astro SSR (standalone Node
# adapter), byte-for-byte the shape can-portal / can-controller / can-efb use.
#
# **This image holds no database credential and no Secret of any kind.** It
# reaches can-db over the cluster network and forwards the member's can-api
# cookie; can-db holds the only PostgreSQL password in the network.
FROM oven/bun:1 AS build
WORKDIR /app

# Manifest first so the dependency layer survives a source change.
# Host .npmrc files are excluded; generate registry config with a literal token placeholder.
COPY package.json bun.lock ./
RUN printf '%s\n' '@jianyuelab-org:registry=https://npm.pkg.github.com' '//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}' > .npmrc
# The token arrives as a BuildKit secret, never --build-arg: the latter is
# readable from `docker history` on a pushed image.
RUN --mount=type=secret,id=github_token \
    GITHUB_TOKEN="$(cat /run/secrets/github_token)" \
    bun install --frozen-lockfile

COPY . .
RUN bun run build

RUN --mount=type=secret,id=github_token \
    rm -rf node_modules && \
    GITHUB_TOKEN="$(cat /run/secrets/github_token)" \
    bun install --frozen-lockfile --production

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4321

# A number, not a name: Kubernetes' runAsNonRoot only reads numeric ids.
USER 1000

COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/package.json ./package.json

EXPOSE 4321
CMD ["node", "./dist/server/entry.mjs"]
