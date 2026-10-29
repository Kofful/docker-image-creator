# Architecture

## Proposed stack
- Backend: NestJS with strict TypeScript, validation, REST endpoints, and an authenticated terminal gateway.
- Frontend: Vue 3, Vite, Vue Router, Pinia for session/application state, and xterm.js for terminal display.
- Persistence: MySQL with Prisma migrations; MySQL-backed sessions and durable operation records avoid requiring Redis for the MVP.
- Agent: provider-neutral adapter producing structured validated output through a bounded generation loop.
- Execution: separate NestJS runner process using Docker Compose v2 for lifecycle operations and the Docker Engine exec API for interactive terminals. Select the maintained Engine client during implementation.
- Workspace: pnpm; exact Node, package, Docker, and MySQL versions must be pinned after compatibility checks at scaffold time.

## Planned repository
```text
apps/
  api/                 # auth, catalog, configs, generation, operations, terminal gateway
  web/                 # Vue pages, UI components, API client, terminal adapter
  runner/              # operation leases, Compose execution, Docker exec, reconciliation
packages/
  contracts/           # versioned schemas, API types, operation/terminal events
infra/                 # application Compose files and development infrastructure
docs/                  # planning and subsequent operational documentation
```

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
