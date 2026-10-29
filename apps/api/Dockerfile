FROM node:22.23.4-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@10.34.9
COPY . .
# Bootstrap only: switch to --frozen-lockfile once registry access can generate the lockfile.
RUN pnpm install --no-frozen-lockfile
RUN pnpm --filter @docker-image-creator/api... build

FROM node:22.23.4-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
