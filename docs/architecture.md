# Architecture

## Implemented scaffold

`infra/docker-compose.yml` builds `docker-image-creator-web:local` from `apps/web/Dockerfile` and `docker-image-creator-api:local` from `apps/api/Dockerfile`, and runs `mysql:8.4.11`. All three join the Compose project-scoped `infrastructure` bridge network. MySQL stores data in the project-scoped `mysql-data` named volume. Neither API nor MySQL publishes a host port. Web publishes port 8080 on loopback by default.

Deployment configuration comes from the repository root `.env`, explicitly selected with `docker compose --env-file .env -f infra/docker-compose.yml`. Web port, MySQL database/account names, and passwords are interpolated from that file, with shell overrides supported. Only the declared MySQL variables are passed into the MySQL container; the API currently needs no database configuration. `infra/config.example` documents the keys without secrets. Agent checks use a separate secret-free configuration file and never load the root `.env`.

The Vue 3/Vite application uses strict TypeScript and `<script setup lang="ts">`. Its built assets are served by Nginx, which proxies `/api/` to `api:3000`. Nest exposes only `GET /api/v1/health`, with a shared response interface in `packages/contracts`. The endpoint checks API liveness only, not database connectivity. Compose waits for an authenticated MySQL `SELECT 1` before starting API, then for API health before starting web, using [Compose health dependencies](https://docs.docker.com/compose/how-tos/startup-order/).

Build stages use `node:22.23.4-bookworm-slim` and pnpm 10.34.9. The frontend runtime uses `nginx:1.28.0-alpine`; the API runtime runs as the `node` user. No service mounts the Docker socket. Build contexts allowlist source/config inputs and exclude environment files, dependencies, and runtime artifacts.

The pnpm workspace and package versions are defined, but a resolved lockfile could not be generated because registry DNS was unavailable, including on an elevated retry. Dockerfiles temporarily install without a frozen lockfile. Generating and committing `pnpm-lock.yaml`, then changing both installs to `--frozen-lockfile`, is a remaining scaffold gate. Container boot is also unverified because Docker daemon access was denied. See [local setup](local-setup.md).

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
The separate runner, durable MySQL operations, server-side sessions, immutable revisions, and structured generation contract are planned defaults. Resolve LLM provider/model, specific image tags, terminal/Engine client libraries, resource caps, secret-key provisioning, and session durations during their implementation milestone. Public hosting requires a separate execution isolation design.
