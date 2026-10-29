FROM node:22.23.4-bookworm-slim AS build
WORKDIR /app
RUN npm install --global pnpm@10.34.9
COPY . .
# Bootstrap only: switch to --frozen-lockfile once registry access can generate the lockfile.
RUN pnpm install --no-frozen-lockfile
RUN pnpm --filter @docker-image-creator/web... build

FROM nginx:1.28.0-alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
