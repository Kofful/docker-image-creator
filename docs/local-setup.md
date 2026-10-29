# Local setup

## Current behavior

The initial stack contains Vue frontend source in `apps/web`, Nest backend source in `apps/api`, shared transport types in `packages/contracts`, and infrastructure configuration in `infra/docker-compose.yml`. MySQL uses the official image; no application database schema or migrations exist yet. The API health endpoint reports liveness only. The web page displays the API connection status.

This is a partial implementation of milestone 1. Account management, application database access, generation, stack execution, and terminals remain planned.

## Start the three services

Install Docker Engine and Docker Compose v2. Commands below run from the repository root. Compose v2.29.1 is available in the implementation environment; container execution was not available for verification.

Create or update `.env` in the repository root using the keys in `infra/config.example`. Set distinct, nonempty `MYSQL_PASSWORD` and `MYSQL_ROOT_PASSWORD` values. The root `.env` is ignored by Git. If it already exists, preserve its other settings. Then start the services:

```bash
docker compose --env-file .env -f infra/docker-compose.yml up --build -d --wait
```

Open <http://127.0.0.1:8080>. The page should say “API is online”. Check the proxied endpoint:

```bash
curl --fail http://127.0.0.1:8080/api/v1/health
docker compose --env-file .env -f infra/docker-compose.yml ps
```

The endpoint returns `{"status":"ok","service":"api"}`. MySQL should report healthy after an authenticated query against the application database. Web, API, and MySQL join the same project-scoped bridge network and resolve each other by service name. Nginx proxies the browser's `/api/` requests to `api:3000`, so no browser-facing API hostname or CORS configuration is required.

Stop the stack while preserving its database:

```bash
docker compose --env-file .env -f infra/docker-compose.yml down
```

Use the same passwords when restarting an existing volume: the image's initialization variables do not change existing database accounts. Volume deletion is intentionally excluded from routine setup commands. MySQL is application infrastructure and must never join networks belonging to future generated user stacks.

## Environment reference

`infra/config.example` is a secret-free template for the root `.env`; password values are intentionally empty. Start/stop commands explicitly select the root file with `--env-file .env`, since the Compose file lives under `infra`. Compose interpolates the referenced variables and passes the MySQL settings through the service's `environment` mapping. Shell variables override values from the file; unset previously exported values when you want the file's settings to apply. See [Docker's interpolation documentation](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/).

Agents must not access the real `.env`. Agent checks use explicit secret-free configuration instead. Do not print fully resolved Compose configuration with real credentials; use `config --quiet` for validation.

| Variable | Required/default | Purpose |
| --- | --- | --- |
| `MYSQL_DATABASE` | `docker_image_creator` | Database created on first initialization |
| `MYSQL_USER` | `docker_image_creator` | Application account created on first initialization |
| `MYSQL_PASSWORD` | Required, nonempty | Initializes the MySQL application account |
| `MYSQL_ROOT_PASSWORD` | Required, nonempty | Initializes the separate MySQL root account |
| `WEB_PORT` | `8080` | Host web port, published only on `127.0.0.1` |

MySQL port 3306 and API port 3000 are accessible only within the infrastructure network. The API does not yet consume database credentials. No LLM credentials are needed.

## Workspace checks

Use Node.js 22.23.4 and pnpm 10.34.9. The Node line satisfies the documented [Nest runtime requirements](https://docs.nestjs.com/migration-guide) and [Vite requirements](https://vite.dev/guide/); actual package compatibility still needs a successful install/build.

```bash
corepack pnpm install
corepack pnpm typecheck
corepack pnpm build
corepack pnpm format:check
```

The first successful install must produce `pnpm-lock.yaml`; review and commit it, change both Dockerfiles to `pnpm install --frozen-lockfile`, and verify a fresh frozen install before marking milestone 1 complete. Current Dockerfiles use bootstrap installs without a frozen lockfile, so transitive dependencies are not yet reproducible. No lint or automated test suite exists yet.

For local source development, after a successful build, run these commands in separate terminals:

```bash
corepack pnpm --filter @docker-image-creator/api start
corepack pnpm --filter @docker-image-creator/web dev
```

Vite proxies `/api` to `127.0.0.1:3000` and explicitly disables environment-file loading. MySQL is not required for the current liveness-only API.

## Verification record and remaining prerequisites

Compose configuration was validated without starting containers, using explicit non-secret test values:

```bash
MYSQL_PASSWORD=validation-only MYSQL_ROOT_PASSWORD=validation-root-only \
  docker compose --env-file /dev/null -f infra/docker-compose.yml config --quiet
```

The root-file configuration change was also checked with a temporary secret-free input file: custom web port and MySQL values were interpolated correctly, omitted optional values used their defaults, all three services retained the shared network, and empty passwords were rejected. The real root `.env` was not accessed.

Source/config JSON parsing and whitespace checks were also run. A cached TypeScript 5.9.3 compiler was installed offline under `/tmp/docker-image-creator-check`; shared-contract checking passed with `node /tmp/docker-image-creator-check/node_modules/typescript/bin/tsc --noEmit -p packages/contracts/tsconfig.json`. Transpilation syntax checks also passed for five TypeScript source/config files; these do not validate application imports or Vue templates.

npm registry access failed with `EAI_AGAIN` even after an elevated retry, preventing workspace package installation and lockfile generation. Docker daemon access was denied even after an elevated retry, preventing image builds, service startup, HTTP checks, network/DNS verification, and real MySQL readiness checks. Formatting, full application type checking, and application builds have not passed verification. These remain explicit milestone 1 gates.
