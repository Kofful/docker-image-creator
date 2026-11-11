# Product requirements

Authenticated users describe a small container environment, supply required values, and generate one Compose document using approved images. They review the validated original document, explicitly Start a lasting deployment, and connect to running services through container terminals. Generation, lifecycle controls, supplied values and terminals are implemented. [History](history.md) separates source verification from live-model/deployment evidence.

The MVP targets trusted users on one dedicated Docker host. Node.js, Python, MySQL and MongoDB are supported through pinned catalog tags. Configurations have 1–4 services, one replica per service and one isolated network. Application MySQL is separate infrastructure. Workloads cannot reach the host, internet, infrastructure or other configurations; published workload ports are rejected.

## Screens

| Route                           | Implemented behavior                                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `/register`, `/login`           | Email/password accounts without email transport; registration signs in immediately                         |
| `/account`                      | Current user and logout; protected memory-only session                                                     |
| `/configs/new`                  | Service selection, settings, masked/shared environment values, instructions and Generate                   |
| `/configs`                      | Owned saved configurations, generation status, detail navigation and confirmed Delete                      |
| `/configs/:id`                  | Generation progress/errors, original Compose preview, Start/Stop/Delete, observed service rows and Connect |
| `/configs/:id/console/:service` | Same-tab interactive terminal, resize, Disconnect and explained return to detail                           |

Login/Create use centered 35rem maximum width; other pages use available width with shared padding. Forms support loading/empty/error states and keyboard interaction. Server authorization remains authoritative. No browser token or secret input persistence; page reload requires login.

## Main workflow

1. Register/login; select named services and settings.
2. Supply every required environment value and purpose, sharing values across services when needed. Keep credentials out of instructions/purposes; only metadata/opaque references reach the model.
3. Generate asynchronously. Validate one model response and retain it encrypted before validation. Invalid content fails without repair/fallback; no Docker startup occurs.
4. Review accepted original YAML, then Start explicitly. Runner revalidates and executes identical saved bytes with private value injection.
5. Inspect per-service state/health; Connect to an authenticated Docker exec shell. Images need Bash or sh; neither is installed automatically.
6. Stop and restart the same revision with named data volumes retained. Workloads survive API/runner restarts; service exit/host reboot requires explicit Start.
7. Delete only after verified stopped/absent state. Cleanup stays visible/retryable until complete; persistent data is retained.

One running configuration per user is reserved through pending/partial/unknown state until verified stopped. There is no global running-count cap. Terminal idle/lifetime/count quotas were explicitly declined; authentication expiry, transport bounds and container limits still apply. UI observations refresh on entry/lifecycle actions and stop polling when settled.

## Acceptance and scope

[Milestones](implementation-plan.md#current-acceptance-criteria) track authentication/revocation, owner isolation, exact artifact execution, policy/admission, cleanup, terminals and evaluation gates. The explicit [ten-case evaluator](evaluation/terminal-runner.md) uses disposable resources, independent probes, three scores out of ten and file reports without database records; it is not automatic product validation.

Deferred: automatic product trials; revision editing/history/export; secret rotation; explicit production-volume deletion; provider selection/list lifecycle controls/service logs in UI; arbitrary YAML imports/builds/Dockerfiles; extra source/dependency installation; private registries/Git integration; additional images; remote Docker/Kubernetes; teams/billing; email verification/reset/OAuth/MFA; SSH/database GUI; public hostile multi-tenant hosting. Legacy template configurations are retained but unsupported and require the previous version for stop/drain before upgrade.
