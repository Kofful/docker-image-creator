# Architecture

Docker Image Creator runs on one dedicated Docker host for trusted users. Vue, NestJS API, MySQL, and a separate runner form the application. Generated workloads run alongside them, each configuration on its own private network. The [root README](../README.md#system-and-information-flow) contains the component and networking diagrams.

## Components

| Component              | Responsibility                                                                                                                    | Access                                                            |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Web (`apps/web`)       | Vue 3 Composition API, Pinia, router, xterm.js; Nginx in production, Vite in development                                          | Same-origin API/terminal proxy; no secrets or Docker access       |
| API (`apps/api`)       | Authentication, owner-scoped requests, generation worker, validation, revisions, runtime admission, terminal relay                | Application MySQL, LLM endpoint, private artifact/log storage     |
| Runner (`apps/runner`) | Separate Nest process implemented in API runtime/terminal modules; claims operations, reconciles resources, serves exec terminals | MySQL, shared artifacts, Docker socket; private terminal listener |
| Application MySQL      | Accounts/sessions, encrypted inputs/values/responses, revisions, operations, reservations, observations, tickets                  | Infrastructure bridge only                                        |
| LLM adapter            | OpenAI SDK Chat Completions against the operator-configured Modal-compatible endpoint/model                                       | Value-free requirements; no execution tools                       |
| Shared contracts       | Transport types and creation/environment rules used by API and Vue                                                                | No frontend ORM/backend implementation imports                    |

TypeScript is strict across the workspace. pnpm and direct dependency/image versions are pinned with a lockfile. API startup deploys committed Prisma migrations and connects to MySQL; health is a liveness response. Compose waits for MySQL health before API, then API health before web/runner.

## Generation and execution

`POST /configs` atomically saves an owned configuration, encrypted values, bindings, and a generation job, then returns 202 for polling. The API worker claims one of two durable generation slots. It sends the model selected services, instructions, policy/catalog, server identities and opaque references. Values are never included.

The adapter accepts one content response, with bounded transient transport retries. Strict validation precedes publication. API stores the exact accepted YAML, SHA-256 digest and derived metadata in an immutable version 2 revision and an atomic private artifact file. Invalid output fails without content repair, procedural generation or a fallback model. Provider responses are retained encrypted before validation; diagnostic HTTP bodies are stored separately with redaction.

Explicit Start creates a durable operation. Runner checks ownership, revision bytes/digest, policy and independently stored bindings again, then supplies the original document on Compose stdin. Only Start decrypts values into declared opaque interpolation keys in a restricted child environment. No runtime renderer patches the document. Model-authored health checks are separate from independent evaluation probes.

Runner records observed aggregate/service states in MySQL. API serves safe owner-scoped summaries. UI polls on page entry and through lifecycle operations, then stops fetching when settled. One configuration per user may reserve a running slot; starting, partial, stopping and unknown states retain it until verified stopped. Per-configuration mutations serialize, with idempotency keys, transactional admission, leases and attempt fencing.

Workloads survive API/runner restarts. Container exits and host reboot require explicit Start; reconciliation reports actual state without automatic relaunch. Failed Start attempts rollback while preserving volumes. Stop preserves data. Delete removes verified stopped containers, network and artifact files before hiding the configuration; failed cleanup remains visible/retryable. Named volumes and encrypted recovery records remain retained.

## Networking and terminals

Web, API, runner and application MySQL share a Compose project-scoped infrastructure bridge. Only web publishes a loopback port. API and runner share artifacts through `generated-configs`; runner alone mounts `/var/run/docker.sock`.

Each generated configuration has one `stack` bridge with `internal: true`, isolated IPv4 gateway mode, IPv6 disabled and ownership labels. Its services communicate by service name/container port. Published workload ports, external networks, host networking and extra attachments are rejected. Scoped Docker tests verify denial of cross-configuration, infrastructure, host and internet access. Runner image pulls do not grant workload egress. Generated MySQL volumes/networks are distinct from application MySQL.

Connect issues a hashed, 30-second one-use ticket bound to the user's session, configuration, applied revision, operation and service. API relays WebSocket traffic privately to runner. Runner consumes the ticket, checks live ownership/policy, and opens a real Docker exec TTY using Bash then sh. It rechecks authorization every second. Disconnect cleans the shell/foreground group where possible without stopping the main service; detached jobs may survive. Terminal content is not recorded. The accepted design imposes no terminal idle/lifetime/count quotas; transport buffers, authentication lifetime and container resources remain bounded.

## Storage and development

| Location                          | Contents and persistence                                                         |
| --------------------------------- | -------------------------------------------------------------------------------- |
| `mysql-data` named volume         | Application database; retained on normal Compose down                            |
| `generated-configs` named volume  | Private original Compose files shared by API/runner                              |
| `.runtime/llm/` host bind         | API redacted HTTP traces; requires a pre-existing UID-1000-writable directory    |
| `.runtime/evaluations/` host bind | Runner reports, recovery artifacts and redacted traces; no evaluation DB records |
| Per-configuration named volumes   | User database data; preserved by Stop and ordinary Delete                        |

Runtime files stay outside Git/build contexts. AES-256-GCM storage uses a separate operator-managed key with configuration-bound authenticated context. Browser bearer/refresh tokens stay in memory; MySQL session checks enforce revocation. See [security](security.md), [authentication](authentication.md), and [runtime bounds](runtime-api.md#runner-provisioning-and-policy).

The Docker development override replaces Nginx with Vite and runs a TypeScript compile/restart supervisor for API. It keeps dependencies in images and mounts selected source/configuration paths; private environment files are not mounted. Invalid API edits leave the last valid process running. Runner remains compiled and must be rebuilt after changes. See [setup](local-setup.md).

## Architectural evolution and limits

Public-image single-document output superseded custom builds (ADR 0002). Shared-host execution replaced nested Docker (ADR 0003). Direct model-authored Compose replaced procedural compilation (ADR 0004); its later amendments select configurable Modal/OpenAI SDK transport and remove content repair. Runtime testing led to rejection of all published workload ports. Prompt v4/v5 add MySQL bootstrap and MongoDB health-check references for the model to author; they do not rewrite saved documents or relax policy.

[History](history.md) records change outcomes. Legacy configurations have no conversion/execution branch; stop/drain them using the previous version before upgrading. Automatic product trials, revision editing/export, secret rotation and explicit production-volume deletion remain deferred. Shared-host Docker is privileged execution and does not provide hostile multi-tenant isolation. Full application deployment and browser end-to-end verification remain unverified.
