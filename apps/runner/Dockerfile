FROM docker:28.5.2-cli AS docker-cli
FROM node:22.23.4-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
FROM base AS build
WORKDIR /app
RUN npm install --global pnpm@10.34.9
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @docker-image-creator/api... build
FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app/apps/api
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/apps/api/node_modules ./node_modules
COPY --from=build /app/apps/api/dist ./dist
COPY --from=build /app/packages/contracts/dist /app/packages/contracts/dist
COPY --from=build /app/packages/contracts/package.json /app/packages/contracts/package.json
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
# Docker control is privileged. Only this private service receives the host socket.
USER root
CMD ["node", "dist/runtime/runner.main.js"]
