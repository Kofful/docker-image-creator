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
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/apps/api/prisma ./apps/api/prisma
COPY --from=build --chown=node:node /app/apps/api/prisma.config.ts ./apps/api/prisma.config.ts
COPY --from=build --chown=node:node /app/apps/api/package.json ./apps/api/package.json
WORKDIR /app/apps/api
USER node
EXPOSE 3000
CMD ["sh", "-c", "node node_modules/prisma/build/index.js migrate deploy && node dist/main.js"]
