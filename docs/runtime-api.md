# Runtime API

Explicit Start/Stop, operation polling, deployment/service observations and stopped-resource deletion are implemented. All routes use `/api/v1`, bearer/session/origin checks and no-store responses. Invisible owner-scoped resources return 404. Generation never starts Docker. Only version 2 [saved Compose](saved-compose-runtime.md) executes; published workload ports are rejected.

## Start a saved revision

```http
POST /api/v1/configs/<configuration-id>/start
Authorization: Bearer <access-token>
Idempotency-Key: <new-UUID>
Content-Type: application/json

{"revisionId":"<saved-revision-UUID>"}
```

Only the owned successful revision ID is accepted; no commands, paths, container IDs or execution settings. The 202 response commits an operation, not startup success:

```json
{
  "operationId": "<operation-UUID>",
  "statusUrl": "/api/v1/operations/<operation-UUID>",
  "pollAfterMs": 2000
}
```

Headers include `Location: <statusUrl>` and `Retry-After: 2`. Runner revalidates exact saved bytes/bindings and resource ownership, checks Docker capabilities, pulls approved images, and waits for health. Successful Start leaves services running with restart policy `no`; API/runner restarts preserve them. Service exits/host reboot require explicit Start. Reconciliation does not relaunch automatically.

Same owner/key/config/action/revision returns the original operation, including after a lost response. Changed input/key reuse across actions returns 409. Explicit retry of a terminal failure needs a fresh key. Pending conflicting operations or another reserved configuration return 409; missing/invalid keys or non-runnable revisions return 400.

## Observe and stop

| Route                         | Behavior                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| `GET /operations/:id`         | Type/revision/status/stage, fixed redacted error, cleanup marker, timestamps              |
| `GET /configs/:id/deployment` | Applied revision, aggregate state, latest operation, observation time                     |
| `GET /configs/:id/services`   | Configured services with pinned image, observed state/health/time; no published endpoints |
| `POST /configs/:id/stop`      | New UUID idempotency key, empty `{}` body; same 202 operation response                    |

Aggregate states include starting/running/stopping/stopped/failed/unknown. Stop verifies ownership/policy and preserves artifacts, encrypted values and stable named database volumes. Failed Start attempts to stop its partially started services while retaining data; cleanup failure remains separate.

User-row locking and a durable reservation enforce one running configuration per user, without a global running-count cap. Starting, stopping, partial and unknown state retain the slot until all services are verified stopped. Mutations serialize per configuration; leases fence stale workers, and expired execution is not replayed as Start. Runner executes two operations concurrently per process.

## Configuration detail UI

Detail shows lifecycle status and one Start/Stop control beside Delete. Start requires a successful revision. Running/failed/unknown deployments offer Stop; starting/stopping actions disable controls. Generation/operation errors remain separate from observed state. Pending operation status takes precedence.

Page entry and explicit Start/Stop refresh deployment, operation and service status. Poll every two seconds while pending/transitioning or an action response is unconfirmed; stop fetching when settled. External changes then require page reload/action. Transient failures back off to 30 seconds and offer manual retry. Navigation cancels requests/timers. Lost action responses retain their idempotency key for explicit retry.

Delete requires never-started or verified stopped state and no unresolved action. Pending/unconfirmed deletion blocks lifecycle actions; recorded deletion intent blocks future Start even after cleanup failure. Stop remains recovery after a terminal deletion failure.

## Per-service container view

The Containers section shows name/image, independent state/health and observation time, plus Connect for running services. Running/unhealthy and exited are observed states, distinct from observation failure. Unknown means unavailable evidence; Not created requires verified absence. Missing health displays a dash. Raw container IDs, inspect data, logs, metrics and per-container lifecycle controls are private/out of scope.

`ConfigServicesResponse` includes `configId`, nullable applied `revisionId`/latest `operationId`, and service entries. Fields include `name`, `image`, `state`, nullable `health`, `observedAt` and retained nullable `publishedPort`; publication is unsupported under current policy. UI rejects identity-mismatched snapshots, retains stale rows with a retryable error, and follows lifecycle polling without idle refresh.

Runner validates live ownership/revision/policy and atomically saves an allowlisted `Deployment.serviceObservations` snapshot with aggregate state. A single inspect failure can leave that service Unknown while retaining independently verified peers; listing/network failure invalidates the whole snapshot. Unknown cannot release a reservation. API selects safe fields against the applied revision rather than returning raw JSON.

## Runner provisioning and policy

Default Compose starts runner after API health/migrations. It uses the application database account, shared encryption key and `generated-configs` artifact volume; only runner mounts `/var/run/docker.sock`. Its private terminal listener has no published port. `apps/runner` packages API's compiled runtime bootstrap and evaluator; rebuild it after source changes even in development.

Linux Engine 28+ with isolated internal bridges and CPU/memory/PID enforcement is required. Incompatible hosts fail `UNSUPPORTED_DOCKER` before creation. The runner image pins Docker CLI 28.5.2 and includes Compose v2.40.3. Workloads use policy 2 labels, approved images, one isolated IPv4 bridge, disabled IPv6, dropped `NET_RAW`, no publication, and exact database volumes. Inspection accepts Docker's equivalent `CAP_NET_RAW` spelling. Compose receives original YAML on stdin, fixed arguments, `/dev/null` environment-file selection and private supplied-value keys; no inherited provider credential or raw stderr.

| Bound                           | Default                                              |
| ------------------------------- | ---------------------------------------------------- |
| Queue lifetime                  | 15 minutes, enforced by active runner                |
| Overall operation / lease grace | 8 minutes / 45 seconds                               |
| Image pull                      | 5 minutes                                            |
| Readiness                       | 120 seconds                                          |
| Stop grace                      | 30 seconds per container                             |
| Inspect command                 | 15 seconds                                           |
| Transient stdout                | 1 MiB; stderr discarded                              |
| Reconciliation                  | Every 2 seconds, batch 20, oldest observations first |

## Delete a stopped configuration

`DELETE /configs/:id` accepts an optional UUID idempotency key. A stopped deployment returns 202 using the operation response above. Active generation returns 403; pending Start/Stop or active/unknown deployment returns 409. No API Docker work occurs.

Admission locks owner/configuration, records `deletionRequestedAt`, and queues `delete`. Duplicate pending requests return the existing operation; matching-key replay works even after success. A new key retries a terminal failure. Deletion intent blocks Start; Stop remains available for recovery after failure.

Runner verifies stopped state, revision/policy/ownership and network attachments; removes stopped containers without force/volume flags, removes the private network, verifies absence, then removes shared artifacts. Missing resources are safe to retry. Only verified cleanup plus a fenced terminal transaction hides the configuration/releases saved quota. Failure/expiry/interruption stays visible and retryable; stopped state alone cannot clear failed cleanup.

Named volumes, encrypted secrets, revisions and operation/deployment history remain retained. A completed delete operation stays owner-readable after the configuration disappears so a final poll cannot be lost. Never-started configurations keep immediate 204/artifact cleanup; repeated deletion without a matching runtime-operation key returns 404. Explicit persistent-data deletion is deferred.

## Verification

`pnpm test:api` uses disposable MySQL with all migrations replayed, controlled lifecycle drivers, policy-rejection tests and separate real scoped cleanup/terminal checks. `pnpm test:runtime` covers four pinned images, readiness, exact artifact/value delivery, same-configuration connectivity, outbound/host/cross-configuration denial and data retention. Tests verify ownership before deleting disposable resources/volumes. [History](history.md) records passes and the earlier Engine-27 prerequisite block; production/browser verification remains separate.
