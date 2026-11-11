# Saved Compose execution

Creation requires version 2 and complete environment arrays/bindings. The procedural compiler, fake provider, runtime renderer and generated-password path are removed. Missing inference settings fail generation explicitly; startup makes no model request.

## Exact execution boundary

`runtime.manifest.ts` validates saved revisions rather than constructing Compose. Admission, runner execution/reconciliation/deletion, service observations and terminal authorization/cleanup check version, owner/config/revision, exact digest, complete policy and derived metadata against independently stored service/binding records. Binding order is immaterial; purposes, references and assignments must match.

Deployment `manifest`/`digest` copy the accepted revision exactly. Runner verifies equality and sends those original bytes to Pull/Up on Compose stdin. The fixed executable uses argument arrays, an empty private temporary project directory, explicit `--env-file /dev/null` and restricted environment. It inserts no command, health check, label, network or volume.

Only Start decrypts supplied values. The child environment has fixed runner `PATH`/`DOCKER_HOST`, `COMPOSE_DISABLE_ENV_FILE=1` and exactly the required `DIC_SECRET_<hex>` keys. Container bindings named `PATH`/`DOCKER_HOST` use opaque keys and cannot override runner settings. Provider keys, session material and arbitrary host variables are never inherited; no secret file is written. Values are delivered without shell interpretation or rewriting Compose.

Live resource inspection verifies ownership/policy labels, images, mounts, network and resource limits. Stop preserves named volumes. Delete removes only verified stopped containers, their private network and owned artifacts, retaining data and encrypted recovery metadata. [Runtime API](runtime-api.md) defines operation limits/admission.

## Network and image constraints

Published ports are rejected to retain internal isolated bridges; use service DNS and container terminals. Workload networking is separate from the application's database network and runner's registry access.

Exact environment delivery does not imply every image initializer handles every value. The stock MySQL initializer failed C09 SQL quoting; prompt v4 adds a [tested bootstrap reference](mysql-bootstrap.md). Prompt v5 adds authenticated MongoDB health-check/YAML guidance; stock MongoDB initialization still failed exploratory CR/LF credentials. References guide future model output; saved artifacts remain unchanged and first-response scoring still applies.

## Legacy boundary and verification

No version 1 execution/conversion path exists. Generation/runtime workers exclude legacy jobs, expiry/reconciliation and artifact cleanup; terminals reject legacy revisions. Retained records/resources are not relabelled or deleted. Stop/drain them with the previous version before following the [upgrade checklist](direct-compose-verification.md#legacy-upgrade).

`pnpm test:api` covers exact DB/file/deployment bytes, ownership/concurrency, pre/post-admission tampering, legacy exclusion, rollback/cleanup and real terminal transport with mocked model output. `pnpm test:runtime` uses four pinned images in disposable projects to check original Compose stdin, supplied values, private connectivity/denial, terminals and MySQL Stop/Start retention. Scoped cleanup verifies labels before removing test-only resources/volumes. These checks passed on Engine 28.1.1; [history](history.md) separates fixture evidence from live model outcomes and pending deployment/browser verification.
