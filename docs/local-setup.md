# Local setup

## Current behavior

The stack contains Vue frontend source in `apps/web`, Nest backend source in `apps/api`, shared transport types in `packages/contracts`, and infrastructure configuration in `infra/docker-compose.yml`. Prisma schema and committed MySQL migrations now create users, sessions, and refresh tokens. The [auth API](authentication.md) implements registration/login/refresh_token/me/logout. The web UI provides login, registration, a protected account page, and logout. The health endpoint reports liveness only.

Milestone 1's verification gates remain incomplete. Backend and browser portions of milestone 2 are implemented in source; see the verification record below. Generation, stack execution, and terminals remain planned.

## Start the three services

Install Docker Engine and Docker Compose v2. Commands below run from the repository root. The development override requires Compose 2.24.4 or later; Compose v2.29.1 is available in the implementation environment.

As a human operator, create or update `.env` in the repository root using the keys in `.env.example`. Set distinct, nonempty `MYSQL_PASSWORD` and `MYSQL_ROOT_PASSWORD` values. Set `DATABASE_URL` to the application account at `mysql:3306`, URL-encoding username/password components and matching the database/account initialization settings. Set `AUTH_ACCESS_TOKEN_SECRET` to a private random signing key containing at least 32 bytes. Set `CONFIG_ENCRYPTION_KEY` to a separate 32-byte key encoded as 64 hexadecimal characters and retain it across restarts. Set `AUTH_TRUSTED_ORIGINS` to the exact browser origin, including the port; adjust it if `WEB_PORT` changes. The root `.env` is ignored by Git. If it already exists, preserve its other settings. Then start the services:

```bash
docker compose --env-file .env -f infra/docker-compose.yml up --build -d --wait
```

Open <http://127.0.0.1:8080>. The page redirects to login. Create an account to open the protected account page, then use Log out to revoke that session. Refreshing the page requires login again because credentials stay in memory. Check the proxied health endpoint separately:

```bash
curl --fail http://127.0.0.1:8080/api/v1/health
docker compose --env-file .env -f infra/docker-compose.yml ps
```

The endpoint returns `{"status":"ok","service":"api"}`. MySQL should report healthy after an authenticated query against the application database. The API container deploys migrations before startup and opens a database connection during Nest initialization. Web, API, and MySQL join the same project-scoped bridge network and resolve each other by service name. Nginx proxies the browser's `/api/` requests to `api:3000`, so no browser-facing API hostname or CORS configuration is required.

Stop the stack while preserving its database:

```bash
docker compose --env-file .env -f infra/docker-compose.yml down
```

Use the same passwords when restarting an existing volume: the image's initialization variables do not change existing database accounts. Volume deletion is intentionally excluded from routine setup commands. MySQL is application infrastructure and must never join networks belonging to future generated user stacks.

## Develop in Docker with automatic reload

Use this mode for UI and API implementation work. It keeps the existing MySQL volume and browser address, including your configured `WEB_PORT`. With the existing root `.env` configured as above, run once:

```bash
docker compose --env-file .env -f infra/docker-compose.yml -f infra/docker-compose.dev.yml up --build -d --wait
```

Keep using the same browser address. The default is <http://127.0.0.1:8080>; the example template sets `WEB_PORT=80`, which uses <http://127.0.0.1>. `AUTH_TRUSTED_ORIGINS` must match that address exactly. You do not need to add port 5173 for Docker development: it is the internal Vite port, mapped to your existing web port.

Vue, CSS, and frontend TypeScript edits hot-reload in the browser. API TypeScript edits compile and restart Nest automatically after a successful build. A type error leaves the last valid API running; fix the error to resume reloads. Both services also see shared contracts source changes. No source edit requires a container rebuild or a Compose command.

Follow compiler/server output with:

```bash
docker compose --env-file .env -f infra/docker-compose.yml -f infra/docker-compose.dev.yml logs -f web api
```

Frontend, contracts, and configuration mounts are read-only. API source is writable so Docker can create its generated-directory mountpoint on a clean checkout; the generated Prisma client itself uses a separate Docker volume. Dependencies stay inside the image. API and MySQL stay private; Vite proxies `/api/` to `api:3000`. No repository root or private environment file is mounted into a container.

| Change                                        | Action                                                                 |
| --------------------------------------------- | ---------------------------------------------------------------------- |
| UI, API, or shared contract source            | Save the file; reload is automatic                                     |
| Dependency manifests, lockfile, or Dockerfile | Repeat the development `up --build` command                            |
| Environment configuration                     | Repeat development `up -d --force-recreate` without `--build`          |
| Prisma schema or committed migrations         | Restart the API; startup deploys migrations and regenerates the client |
| Watcher script                                | Restart the API                                                        |

For example, after adding a committed migration:

```bash
docker compose --env-file .env -f infra/docker-compose.yml -f infra/docker-compose.dev.yml restart api
```

If file changes are not detected on Docker Desktop or WSL, set `DEV_WATCH_POLLING=true` in your configuration and recreate the development containers. Polling uses more CPU. The default uses native filesystem events.

To stop development while preserving database data:

```bash
docker compose --env-file .env -f infra/docker-compose.yml -f infra/docker-compose.dev.yml down
```

To return to compiled production containers, use the original single-file `up --build` command above. Both modes use the same Compose project and database volume when run from this repository; do not add a different project name when switching modes.

An opt-in smoke check builds the dev image, boots a unique disposable Compose project with test-only settings, verifies Vue HMR and API reload/error recovery, checks authentication origin protection, and removes only its own containers, network, and volumes. It edits temporary source copies, uses a random loopback port, and never loads repository environment files:

```bash
corepack pnpm test:dev
```

## Environment reference

The root `.env.example` is the canonical secret-free template for `.env`; real passwords and signing keys belong only in the private deployment configuration. Start/stop commands explicitly select the root file with `--env-file .env`, since the Compose file lives under `infra`. Compose interpolates the referenced variables and passes the MySQL settings through the service's `environment` mapping. Shell variables override values from the file; unset previously exported values when you want the file's settings to apply. See [Docker's interpolation documentation](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/).

Agents must not access the real `.env`. Agent checks use explicit secret-free configuration instead. Do not print fully resolved Compose configuration with real credentials; use `config --quiet` for validation.

| Variable                   | Required/default                                                         | Purpose                                                                                                  |
| -------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `MYSQL_DATABASE`           | `docker_image_creator`                                                   | Database created on first initialization                                                                 |
| `MYSQL_USER`               | `docker_image_creator`                                                   | Application account created on first initialization                                                      |
| `MYSQL_PASSWORD`           | Required, nonempty                                                       | Initializes the MySQL application account                                                                |
| `MYSQL_ROOT_PASSWORD`      | Required, nonempty                                                       | Initializes the separate MySQL root account                                                              |
| `WEB_PORT`                 | `8080`                                                                   | Host web port, published only on `127.0.0.1`                                                             |
| `DATABASE_URL`             | Required                                                                 | `mysql://<encoded-user>:<encoded-password>@mysql:3306/<database>` in Compose; no query options/fragments |
| `AUTH_ACCESS_TOKEN_SECRET` | Required, at least 32 bytes                                              | Private random HS256 signing key; changing it invalidates access tokens                                  |
| `AUTH_TRUSTED_ORIGINS`     | Required for source startup; Compose default `http://127.0.0.1:8080`     | Comma-separated exact HTTP(S) origins, with no trailing slash; add `http://127.0.0.1:5173` for Vite      |
| `DEV_WATCH_POLLING`        | `false`                                                                  | Use polling for API/Vite source watchers in Docker development if native events are unavailable          |
| `API_PROXY_TARGET`         | `http://127.0.0.1:3000` locally; `http://api:3000` in Docker development | Server-side Vite proxy target; not exposed as a browser variable                                         |

MySQL port 3306 and API port 3000 are accessible only within the infrastructure network. The API consumes application database credentials; it never needs the MySQL root password. Prisma CLI and API runtime read process environment only and do not load environment files. No LLM credentials are needed. The auth variables listed above are documented in the root `.env.example`.

## Workspace checks

Use Node.js 22.23.4 and pnpm 10.34.9. The Node line satisfies the documented [Nest runtime requirements](https://docs.nestjs.com/migration-guide) and [Vite requirements](https://vite.dev/guide/); actual package compatibility still needs a successful install/build.

```bash
corepack pnpm install
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm build
corepack pnpm format:check
corepack pnpm --filter @docker-image-creator/api prisma:validate
corepack pnpm test:web
corepack pnpm test:api
```

The workspace now has a resolved `pnpm-lock.yaml`; both Dockerfiles use `pnpm install --frozen-lockfile`. ESLint checks API/contracts TypeScript, Vue components, frontend TypeScript, and the auth test harness. API build/typecheck scripts generate the Prisma client first. The MySQL endpoint suite requires Docker and creates its own disposable database with generated test-only credentials; it does not load any environment file.

For local source development, explicitly export `DATABASE_URL`, `AUTH_ACCESS_TOKEN_SECRET`, `AUTH_TRUSTED_ORIGINS`, and `CONFIG_ENCRYPTION_KEY` in your shell without committing or printing credentials. Use a reachable development MySQL server: the Compose database has no host port. After installing dependencies, deploy migrations and build, then run API and web in separate terminals:

```bash
corepack pnpm --filter @docker-image-creator/api db:migrate
corepack pnpm build
corepack pnpm --filter @docker-image-creator/api dev
corepack pnpm --filter @docker-image-creator/web dev
```

Vite proxies `/api` to `127.0.0.1:3000` and explicitly disables environment-file loading. API startup now requires MySQL, the auth settings, and the generation encryption key, even if only liveness is used. Keep `http://127.0.0.1:5173` in trusted origins when using Vite.

## Verification record and remaining prerequisites

The Docker development image built successfully with the frozen lockfile. The disposable `test:dev` harness passed with native watching and with `DEV_WATCH_POLLING=true`: three-service boot, migrations, Vite API proxy, Vue HMR and changed served content, API recompile/restart, continued service during a type error and recovery after correction, trusted/untrusted registration origins, unchanged container IDs, and graceful API watcher shutdown. Tests used unique project-scoped resources and temporary source copies; cleanup removed their containers, network, and volumes. The application stack and protected environment files were not accessed. API/contracts/web type checks, workspace ESLint plus the smoke script, changed-file formatting, and all 28 frontend tests also passed for this change. This verifies the development deployment; production image boot and runner scaffolding remain separate gates.

Compose configuration was validated without starting containers, using explicit non-secret test values:

```bash
MYSQL_PASSWORD=validation-only MYSQL_ROOT_PASSWORD=validation-root-only \
  DATABASE_URL=mysql://validation:validation@mysql:3306/validation \
  AUTH_ACCESS_TOKEN_SECRET=validation-only-key-with-at-least-32-bytes \
  CONFIG_ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 \
  docker compose --env-file /dev/null -f infra/docker-compose.yml config --quiet
```

Earlier scaffold verification also checked a temporary secret-free input file: custom web port and MySQL values were interpolated correctly, omitted optional values used their defaults, all three services retained the shared network, and empty passwords were rejected. The real root `.env` was not accessed. Auth's updated Compose configuration passed the explicit dummy-value command above.

For the auth change, shared-contract checking passed with the cached TypeScript 5.9.3 compiler: `node /tmp/docker-image-creator-check/node_modules/typescript/bin/tsc --noEmit -p packages/contracts/tsconfig.json`. Transpilation syntax checks passed for 15 API/test/config/contracts TypeScript files, six JSON files parsed, and `node --check` passed for the test harness and ESLint configuration. These syntax checks do not validate application imports, generated Prisma types, or Vue templates. Whitespace checks exclude all protected environment files.

The migration SQL also executed successfully during fresh, isolated MySQL 8.0.42 initialization using `mysqld --no-defaults --initialize-insecure --init-file=<temporary SQL> --datadir=<fresh /tmp directory> --secure-file-priv=NULL`. The temporary SQL selected a disposable database and contained the committed migration unchanged; all three table files were created, with no SQL errors. No existing databases were accessed, and no listening server was left running. This checks MySQL DDL execution, not Prisma deployment, transaction behavior, or HTTP integration against the target MySQL 8.4.11 image.

Earlier backend-only checks could not install dependencies or reach Docker. During the authentication UI change, approved network and Docker retries succeeded: pinned pnpm installed the workspace and generated `pnpm-lock.yaml`, a frozen offline install passed, workspace type checks and Prisma validation passed, all 28 frontend tests passed, and all 24 API endpoint tests passed against disposable MySQL 8.4.11. The API suite applied the committed migration twice and removed its test container and volumes. No protected environment files were accessed.

Workspace ESLint passed with zero warnings, and all workspace builds passed. The repository-wide `format:check` reports pre-existing formatting issues in 21 untouched files (workspace YAML, API/contracts source, and planning docs). Formatting checks for all changed supported files pass; the pnpm-generated lockfile is excluded from Prettier. Full three-service image builds/boot and runner scaffolding remain unverified/incomplete.

The frontend suite (`corepack pnpm test:web`) uses Vitest/jsdom and mocked HTTP responses with the actual Vue views, router, and Pinia/session client. It needs no Docker, MySQL, credentials, or environment files. `corepack pnpm test` runs frontend checks first, followed by the disposable-MySQL endpoint suite.

The pinned pnpm binary was downloaded with `npm exec --cache /tmp/docker-image-creator-npm-cache --yes --package=pnpm@10.34.9 -- pnpm --version`. Checks used that binary with its containing `node_modules/.bin` directory on `PATH`; the `corepack pnpm` commands above are the equivalent normal setup.

## Configuration generation milestone

See [configuration API](configuration-api.md) for request examples, status polling, persistence, and limits. After login, use `/configs/new`, `/configs`, and `/configs/:id`. This implementation uses a deterministic fake and does not start workloads or call a live LLM. Generation completes only when both the database revision and Compose file are saved.

| Variable                | Required/default                                                                                      | Purpose                                                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONFIG_ENCRYPTION_KEY` | Required: 32 bytes encoded as exactly 64 hexadecimal characters; generate with `openssl rand -hex 32` | Separate AES-256-GCM key for input/output and generated database secrets; retain and back up alongside MySQL; key rotation is not implemented |
| `CONFIG_ARTIFACT_ROOT`  | Source: repository `.runtime/configs`; Docker: `/app/.runtime/configs`                                | Private artifact root; Docker persists it in the `generated-configs` named volume                                                             |
| `CONFIG_FAKE_DELAY_MS`  | `0`, maximum `300000`                                                                                 | Fake-provider delay; `120000` demonstrates two-minute generation without credentials or paid calls                                            |

No private environment file was read or modified. A human operator must supply the new encryption key through deployment configuration before restarting the updated API. The `.env.example` remains secret-free. The Compose artifact contains secret placeholders, not passwords; runner secret injection is deferred with Docker execution.

Checks for this change: all 34 frontend tests passed, including simulated three-minute polling and resumed saved jobs. Both migrations deployed twice and all 40 backend checks passed against disposable MySQL 8.4.11, including real Compose parsing with explicit non-secret configuration, owner isolation, encryption, file failure, idempotency, concurrency, deadlines, restart/lease cleanup, and graceful worker interruption. Workspace builds and type checks passed. Full updated development/production Docker image boot, actual workload image pulls/start/readiness, and real LLM calls were not performed for this milestone. The earlier dev-reload verification record above describes the previous image; do not treat it as a rerun of the updated image.

### Configuration deletion (2026-11-01)

The authenticated `DELETE /api/v1/configs/:id` endpoint now soft-deletes database metadata and removes the configuration's private artifact directory. It retains revisions, Compose text, generation records, and encrypted secrets. See [configuration API](configuration-api.md#delete-a-configuration) for the exact 204/403/404/400 behavior and background cleanup guarantees. No new environment variables are required. Restart the API after updating source/schema so its normal startup migration step applies `20261101000000_config_deletion`; source development uses the existing `db:migrate` command with explicitly exported configuration.

`pnpm test:api` passed all 48 backend checks against disposable MySQL 8.4.11. The harness deployed all three committed migrations twice and removed its isolated container and volumes. Coverage includes deletion ownership/session/origin checks, retained data, hidden reads, quota/key behavior, absent files, durable cleanup across restart, fair cleanup batches, and concurrent deletion/publication. No protected environment files were read. Frontend behavior and Docker workload execution were outside this endpoint-only change.

The subsequent UI change adds Delete buttons to `/configs` and `/configs/:id`, with a browser confirmation, pending-request protection, and an explanation while generation prevents deletion. List deletion removes the selected row; detail deletion returns to the list. Use **Refresh configurations** on the list to update generation status. Already-removed configurations disappear on a 404; rejected or unconfirmed deletions remain visible with a retryable error. No additional setup is required.

UI verification: all 49 frontend tests passed, including deletion from both pages, confirmation cancellation, pending requests, queued/running/failed generation, stale 404s, error/retry behavior, and an overlapping list refresh. Workspace type checking, lint, the production web build, and changed-file formatting passed. The backend suite was not rerun for the UI-only follow-up; no interactive browser or Docker workload check was performed.
