# Architecture

## Implemented scaffold

`infra/docker-compose.yml` builds `docker-image-creator-web:local` from `apps/web/Dockerfile` and `docker-image-creator-api:local` from `apps/api/Dockerfile`, and runs `mysql:8.4.11`. All three join the Compose project-scoped `infrastructure` bridge network. MySQL stores data in the project-scoped `mysql-data` named volume. Neither API nor MySQL publishes a host port. Web publishes port 8080 on loopback by default.

Deployment configuration comes from the repository root `.env`, explicitly selected by the human operator with `docker compose --env-file .env -f infra/docker-compose.yml`. Only declared MySQL variables are passed into MySQL. API configuration now includes `DATABASE_URL`, `AUTH_ACCESS_TOKEN_SECRET`, and `AUTH_TRUSTED_ORIGINS`. Use the root `.env.example` as the secret-free configuration template. API code, Prisma configuration, and agent checks do not load environment files; source development uses exported process variables.

The Vue 3/Vite application uses strict TypeScript and `<script setup lang="ts">`. Its built assets are served by Nginx, which proxies `/api/` to `api:3000`. Nest exposes liveness and the [authentication endpoints](authentication.md), with shared transport interfaces in `packages/contracts`. Liveness itself does not query the database, but API startup now requires a database connection. Compose waits for an authenticated MySQL `SELECT 1` before starting API, then for API health before starting web, using [Compose health dependencies](https://docs.docker.com/compose/how-tos/startup-order/). The API container applies committed Prisma migrations before starting Nest.

Build stages use `node:22.23.4-bookworm-slim` and pnpm 10.34.9. The frontend runtime uses `nginx:1.28.0-alpine`; the API runtime runs as the `node` user. No service mounts the Docker socket. Build contexts allowlist source/config inputs and exclude environment files, dependencies, and runtime artifacts.

The API image additionally includes OpenSSL for Prisma migration tooling, the schema/migrations, and its Prisma configuration. Prisma CLI remains in the image for startup migrations. Build-time client generation uses a placeholder URL and never requires production credentials. The generated CommonJS client is compiled into the API output and is not tracked in Git.

The pnpm workspace uses pinned direct package versions and a resolved `pnpm-lock.yaml`. Both Dockerfiles install with `--frozen-lockfile`. Container boot remains a separate verification gate. See [local setup](local-setup.md).

### Docker development

The optional `infra/docker-compose.dev.yml` override runs API and web from the shared `infra/Dockerfile.dev` image as the unprivileged `node` user. Dependency manifests are copied before source to cache installation. Mounts expose only application source, shared contracts, and selected non-secret configuration. Frontend/contracts/config mounts are read-only; API source is writable so Docker can create the empty generated-directory mountpoint on a clean checkout. Generated Prisma files use an anonymous Docker volume over that subtree. Host dependencies and private environment files are never mounted. Docker's init process forwards signals and reaps child processes.

Vite listens on internal port 5173 and replaces Nginx in this mode, preserving the configured loopback `WEB_PORT` through a [Compose port override](https://docs.docker.com/reference/compose-file/merge/#replace-value) (Compose >= 2.24.4). Its server-side proxy uses `API_PROXY_TARGET=http://api:3000`; browser requests and API origin checks remain unchanged. Local Vite defaults to `http://127.0.0.1:3000`. Vite still disables environment-file loading. `DEV_WATCH_POLLING=true` enables polling in both watchers for hosts without reliable mount events.

API development uses TypeScript's watch compiler and the existing strict/decorator-metadata settings. After each successful complete compilation, a small process supervisor terminates the previous Nest process, waits for shutdown (forcing it after five seconds), and starts the new compiled entry point. Invalid edits leave the last valid server running. SIGINT/SIGTERM close the watcher and child server. Startup deploys committed Prisma migrations and regenerates the client; schema/migration changes require an API restart. Dependency changes require rebuilding the development image; environment changes require recreating containers. The original single-file production deployment remains available, and both modes retain the same project-scoped database volume. See [local setup](local-setup.md) for switching commands and the disposable live-reload check.

## Implemented configuration generation (2026-10-30)

[ADR 0002](adr/0002-compose-only-generation.md) supersedes custom builds with approved public images and fixed Node/Python HTTP starters. [Configuration API](configuration-api.md) documents implemented creation, shared contracts, DTO/catalog validation, immutable initial revisions, and encrypted generation inputs/output/secrets. Only one Compose document is generated, without Dockerfiles or adjacent authored source files. A deterministic fake sits behind the provider adapter; live provider selection remains deferred.

`POST /configs` saves a configuration and queued job transactionally and returns 202. An API lifecycle worker claims MySQL jobs with `FOR UPDATE SKIP LOCKED`, server-generated fencing tokens, and two durable global slots. User-row locking admits at most one outstanding job per user. Generation has a five-minute deadline, 30-second lease grace, and 15-minute queue bound. Queued jobs survive restart; expired running jobs fail without automatic provider replay. Worker shutdown aborts active generation and finishes bookkeeping before Prisma pools disconnect.

The compiler emits JSON-formatted YAML with fixed images/commands, project labels, a project-scoped bridge network, resource/log limits, optional loopback ports, and named database volumes. Returned output is retained encrypted before validation; only safe server-compiled content is written. A flushed temporary file is renamed to `.runtime/configs/<user>/<config>/<revision>/compose.yaml` before success and the immutable revision commit together. Files are mode 0600, directories 0700, and paths reject symlinks. Failed uncommitted artifacts are removed or tracked for retryable cleanup. Source defaults to the ignored repository tree; Docker uses a persistent `generated-configs` named volume at `/app/.runtime/configs`.

Vue creation/list/detail pages poll with short authenticated HTTP requests and no overall browser deadline. Temporary transport errors back off without another creation request; re-opening a saved configuration resumes polling. Owner-scoped UUID idempotency keys make lost creation responses retryable. Tokens continue using the existing memory-only session/serialized refresh flow.

The API never accesses Docker. A current `succeeded` job means generation and file/DB persistence succeeded, explicitly accompanied by `provider: fake` and `runtimeValidation: not_performed`. Only the future private runner may pull/start containers, check readiness, observe for ten seconds, stop trials, reconcile Docker resources, or manage lasting deployments. Database readiness probes, actual image startup verification, and secret injection remain runner prerequisites.

## Target stack

- Backend: NestJS with strict TypeScript, validation, REST endpoints, and an authenticated terminal gateway.
- Frontend: Vue 3, Vite, Vue Router, Pinia for session/application state, and xterm.js for terminal display.
- Persistence: MySQL with Prisma migrations; MySQL-backed sessions and durable operation records avoid requiring Redis for the MVP.
- Agent: provider-neutral adapter producing structured validated output through a bounded generation loop.
- Execution: separate NestJS runner process using Docker Compose v2 for lifecycle operations and the Docker Engine exec API for interactive terminals. Select the maintained Engine client during implementation.
- Workspace: pnpm; initial versions are pinned in manifests and Dockerfiles, with clean installation and full compatibility checks still pending.

## Repository layout

```text
apps/
  api/                 # auth, catalog, configs, generation, operations, terminal gateway
  web/                 # Vue pages, UI components, API client, terminal adapter
  runner/              # planned; not scaffolded/deployed in the three-service setup
packages/
  contracts/           # versioned schemas, API types, operation/terminal events
infra/                 # application Compose files and development infrastructure
docs/                  # planning and subsequent operational documentation
```

`apps/api`, `apps/web`, `packages/contracts`, and `infra` now exist. Runner scaffolding remains part of milestone 1; no execution worker is active.

## Request and execution flow

The browser talks only to the API. The API validates requests, checks ownership, persists revisions and operations, and makes bounded generation calls. A separate runner claims durable operations from MySQL using atomic leases and executes them against its Docker daemon. The API relays terminal traffic over an authenticated private runner connection; the browser cannot reach the runner directly.

The runner receives internal IDs, then loads validated revision data. It must not accept arbitrary Compose paths, host paths, commands, or Docker container IDs from a browser. Its internal terminal protocol authenticates the API and binds each session to an owned stack, service, and deployment. Worker credentials, database permissions, and network placement must be documented when provisioning it.

## Infrastructure separation

The application's API, database, and private runner transport use an infrastructure network. Generated services join only their own Compose project's network. Do not attach generated workloads to the infrastructure network. Limit published ports to explicitly requested loopback mappings. Running the control plane in containers requires a deliberate runner/socket arrangement; mounting the host socket grants powerful host access even inside a container.

## State and durability

A saved configuration has immutable revisions; generation attempts and runtime operations are separate records. A deployment points to its applied revision. Store desired state separately from observed Docker state. Poll and reconcile server-owned labels after restarts, runner lease expiry, crashes, and out-of-band Docker changes. Do not infer successful execution solely from a database flag or a lost HTTP response.

Only one mutating operation per stack may execute at a time. Leases, operation attempt IDs, idempotency keys, and reconciliation prevent duplicate effects. A timed-out worker may have left running containers: fence its attempt and inspect Docker before retrying. Retain volumes on failures and surface partial results.

## Decisions and open choices

The separate runner, durable MySQL operations, immutable revisions, and structured generation contract are planned defaults. Resolve LLM provider/model, specific image tags, terminal/Engine client libraries, resource caps, and secret-key provisioning during their implementation milestone. Public hosting requires a separate execution isolation design.

### Auth decision: access and refresh tokens (2026-10-30)

The requested API uses bearer access JWTs plus opaque refresh tokens instead of the original cookie-session plan. Access tokens last 15 minutes; sessions have an absolute seven-day lifetime. MySQL session checks make logout/replay revocation immediate. Refresh-token consumption and replacement occur in one transaction; replay revocation commits before returning 401. Simultaneous refresh requests intentionally revoke the session, so clients must serialize refreshes.

Prisma 7.10.0 uses the maintained MySQL/MariaDB driver adapter and the [`prisma-client` generator's CommonJS support](https://www.prisma.io/docs/orm/v7/prisma-schema/overview/generators). Unlike the legacy generator, it does not load environment files at runtime. Prisma configuration likewise has no dotenv import. Connection pools are bounded to five with five-second connection/acquisition timeouts; timestamps use UTC. Database URL components must be URL-encoded; URL query options/fragments are rejected rather than silently ignored. The current adapter setup targets the private local MySQL network; remote TLS configuration is not implemented. It explicitly permits [server RSA-key retrieval](https://mariadb.com/docs/connectors/mariadb-connector-nodejs/node-js-connection-options) for MySQL 8 caching_sha2_password on that network and disables query-parameter logging.

`AuthModule` owns controllers, credential validation, tokens, origin/rate controls, and Prisma persistence. `AccessTokenGuard` is exported for later protected modules; new protected controllers must use it explicitly. The health route is public. Shared request/response interfaces live in `packages/contracts`; no ORM model crosses that boundary. Backend tests use actual Nest HTTP handling and disposable MySQL, with no mocked persistence or paid services. Cookie transport/CSRF mechanisms, terminal authorization, expired-session cleanup, and session quotas remain planned.

### Browser authentication (2026-10-30)

Vue Router exposes `/login`, `/register`, and the protected `/account` landing page. Root and unknown URLs resolve to the account page for signed-in users and login for guests. Configuration creation/list/detail routes are implemented with background status polling; runtime controls remain planned. Pinia exposes the current user and authentication actions; tokens stay in a private session-client closure, outside Pinia's serializable state and browser storage. Reloading or closing a page requires a new login. Reloading does not revoke the server session; explicit logout calls the API to revoke it.

The client uses same-origin `/api/v1/auth` requests with cookies omitted, no-store caching, and ten-second request deadlines. It checks `/me` on account entry, refreshes before requests within five seconds of access expiry or after a 401, shares one in-flight refresh, and retries a protected request at most once. A delayed 401 for an old access token reuses the already-rotated token. Failed or lost refresh responses clear local credentials rather than replaying a potentially consumed refresh token. Generation checks prevent late responses from restoring a logged-out session. Retryable logout failures keep the logout control available until revocation can be confirmed. Revocation is detected on API use; there is no background polling or terminal transport yet.

Vitest and Vue Test Utils exercise the real Vue views, router, Pinia store, and session client with mocked HTTP responses; these tests do not replace the disposable-MySQL backend suite. Vite and Vitest both disable environment-file loading.
