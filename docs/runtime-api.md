# Configuration execution API

Status (2026-11-03): Start, Stop, operation polling, deployment status, per-service container observations, durable MySQL admission, a separate private runner, and configuration-detail runtime controls are implemented as slices of milestone 5. Stopped-resource deletion is implemented through DELETE and the runner. Terminals, automatic temporary validation, and explicit persistent-data deletion remain follow-ups. Real workload startup and network/volume behavior require the supported-host smoke gate below; controlled-driver API tests do not prove those Docker behaviors.

## Start a saved revision

```http
POST /api/v1/configs/<configuration-id>/start
Authorization: Bearer <access-token>
Idempotency-Key: <new-UUID>
Content-Type: application/json

{"revisionId":"<saved-revision-UUID>"}
```

The caller must own the non-deleted configuration and its selected successful revision. Only `revisionId` is accepted. Container IDs, Compose paths, commands, environment values, and runtime options are rejected. Generate/save does not invoke Docker; the fake generation provider remains in place.

The response is **202 Accepted**, with `Cache-Control: no-store`, `Retry-After: 2`, and `Location` equal to `statusUrl`:

```json
{
  "operationId": "<operation-UUID>",
  "statusUrl": "/api/v1/operations/<operation-UUID>",
  "pollAfterMs": 2000
}
```

This acknowledges a committed operation, not successful startup. The runner validates the saved spec and resource ownership, checks Docker capabilities and port conflicts, pulls catalog images, and waits for service-specific readiness. Successful Start leaves services running with restart policy `no`. API/runner restarts leave completed workloads alone; service exits and host reboot require explicit Start. Reconciliation never automatically relaunches a deployment.

Repeat the same key/configuration/action/revision to retrieve the original operation, including after a lost response. Changed input under the same key returns 409. An explicit retry of a failed operation needs a new key. Keys are owner-scoped across runtime actions. Pending operations and reserved configurations return 409. Missing/invalid keys and malformed or non-runnable revisions return 400; unknown/deleted/unowned configurations return 404. Authentication, session revocation, and origin checks match other protected API routes.

## Observe and stop

| Route                                | Behavior                                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /api/v1/operations/:id`         | Owned type, revision, status, stage, fixed redacted error, cleanup marker, timestamps                                                |
| `GET /api/v1/configs/:id/deployment` | Owned applied revision, starting/running/stopping/stopped/failed/unknown state, latest operation ID, observation time                |
| `GET /api/v1/configs/:id/services`   | Owned configured services with image/tag, observed container state/health, verified published port, and per-service observation time |
| `POST /api/v1/configs/:id/stop`      | Bearer token, new UUID idempotency key, empty `{}` body; returns 202 and operation URL                                               |

Stop verifies container ownership/policy and preserves artifacts, encrypted secrets, and named database volumes. Start reuses the configuration's stable volume names. Failed startup attempts to stop its partially started services while preserving data; unresolved cleanup is reported separately. Starting, stopping, partial running state, and unknown Docker state retain the user's slot; release requires verifying all services stopped.

User-row locking and a unique durable reservation enforce **one running configuration per user, without a global running-configuration count cap**. Two operations execute concurrently per runner process; this does not cap already running deployments. Database port reservations prevent competing configurations from claiming one host port; Docker also rejects ports held by unrelated host processes. Configuration operations serialize and idempotency survives API/runner restarts. Expired execution leases fail without replaying Start.

## Configuration detail UI

`/configs/:id` replaces the former Generation line with a runtime status label: Not started, Starting, Running, Stopping, Stopped, Failed, or Unknown. Generation progress and errors remain separate. A deployment 404 means Not started after the owned configuration has loaded; a failed status check shows Unknown and disables actions until status recovers.

One lifecycle button sits immediately left of Delete. Start uses the saved successful revision and is disabled until it exists; Stop replaces it for running, failed, or unknown deployments. Starting/Stopping show a disabled progress button. Pending operation status takes precedence over the observed deployment state. Failed or unknown deployments offer Stop until verified stopped; a rolled-back Start can show Stopped while retaining its operation error. Stop preserves persistent data.

The page checks deployment and latest-operation status on load. It polls every two seconds only while an operation is queued/running, the deployment is starting/stopping, or an action response remains unconfirmed. Once the status settles (including Running, Stopped, Failed, Unknown, or Not started), fetching stops until an explicit Start/Stop action or a page reload. An operation already in progress when the page opens is followed to completion. External exits and changes from another tab after polling stops appear on the next page load or explicit action. Transient status-request failures back off to at most thirty seconds until recovery; a manual status retry is also available. Navigation cancels timers and requests. Actions use authenticated API requests and fresh UUID idempotency keys; a lost response is retried only by an explicit click with the same key, while polling can discover the committed operation. A confirmed failed operation can be retried with a new key. Admission conflicts remain server-authoritative and appear as a recoverable error.

The detail page enables Delete for never-started and verified stopped configurations. Unknown/active deployments, unavailable runtime status, and pending/unconfirmed runtime actions block deletion. Both list and detail wait for accepted cleanup operations, resume pending deletion on reopening, show retryable cleanup failures, and remove the configuration only after success. Pending or unconfirmed deletion blocks lifecycle controls; a failed deletion continues to block Start, while Stop remains available when needed for recovery.

## Per-service container view

Implemented on 2026-11-03: a read-only **Containers** section appears above the saved Compose preview on the configuration detail page. It lists every configured service, including services whose containers have not been created or have exited. Each row shows service name, image/tag, container state, health when available, any verified published host port, and last observation time. Container IDs, resource metrics, logs, per-container controls, and interactive terminals are outside this slice; existing configuration-wide Start/Stop controls remain.

Container observations follow the existing configuration-status refresh flow: page entry and explicit Start/Stop actions. Rows follow existing operation polling through successful or failed Start/Stop, including an operation already pending on page entry, then stop refreshing once status settles. There is no recurring refresh while idle. Existing status-recovery backoff/manual retry and navigation cancellation remain. A later external container exit becomes visible on the next page entry or lifecycle action. These decisions do not change the runner's background reconciliation schedule or grant Docker access to the API/browser; displayed runtime information is the latest runner observation, not a synchronous Docker query from the page.

Container state and health are independent: a running unhealthy container shows **Running · Unhealthy**, even when the aggregate configuration state is Failed. An exited container is a successfully observed outcome, not a retrieval failure. Health is shown only when available; aggregate configuration state must not be copied into every row.

If an API request fails, retain previously observed rows, mark their runtime information stale, and show a retryable section error. Without a previous observation, configured services show **Unknown** while known definition metadata remains visible. If the runner cannot inspect one container, show **Unknown** for that service and retain successfully verified observations for other services when independently trustworthy. A deployment-wide observation failure must not be presented as verified per-service results. Show **Not created** only when the runner has verified absence; inability to retrieve a container's status does not establish absence. Previously observed state must not be presented as current after a failed observation, and unknown published-port information must not be replaced with a requested port as though publication were verified.

`GET /api/v1/configs/:id/services` returns `ConfigServicesResponse` from `packages/contracts`: `configId`, nullable applied `revisionId` and latest `operationId`, and `services`. Each service has `name`, pinned `image`, `state`, nullable `health`, nullable `publishedPort` (`host`, `hostPort`, `containerPort`), and nullable `observedAt`. States are Not created, Created, Running, Restarting, Paused, Exited, Dead, Removing, and Unknown. Missing health is displayed as a dash. A service that has never been observed, including a never-started configuration, is Unknown with no observation time; reading this endpoint never creates a deployment or invokes Docker. Missing/deleted/unowned configs return 404, and authentication/session/origin checks match the other runtime routes. Responses use `Cache-Control: no-store`.

The runner stores an allowlisted JSON snapshot in `Deployment.serviceObservations`, atomically with the aggregate deployment result. Per-service listing/inspection validates the same ownership/revision/policy rules as lifecycle operations. A single inspect failure produces Unknown for that service; listing/network failures invalidate the whole snapshot. Unknown observations cannot prove stopped or release a reservation. The API returns only explicit safe fields matched to the applied revision's service definitions. The UI checks configuration/revision/operation identity before accepting a response; mismatches retain stale observations and use existing retry/backoff. Service-request failures do not replace a successful aggregate status check or change its lifecycle guards.

Apply migration `20261103000000_service_observations` before running the updated API/runner, and rebuild/recreate their compiled images alongside web. Existing deployment snapshots start as null and remain Unknown until an updated runner observes them. No new environment variables are required. Deployment of these changes is not part of the source/test verification.

## Runner provisioning and policy

Only the runner receives `/var/run/docker.sock`; neither API nor generated containers can access it. The private runner publishes no port. It is included in the default [infra/docker-compose.yml](../infra/docker-compose.yml), waits for API health/migrations, and uses the same private database and encryption key. The development override inherits it without another Compose file; runtime source changes require rebuilding its compiled image. Do not supply the application MySQL root account.

The runner image pins Docker CLI 28.5.2; its Compose binary reports v2.40.3. The Nest bootstrap is compiled in API's `src/runtime/runner.main.ts`; `apps/runner` supplies a workspace command and separate image. This shares Prisma/compiler code without registering the privileged driver in the API. Source execution: build API, then `pnpm --filter @docker-image-creator/runner start`, using explicitly exported configuration and local socket access.

Requirements: Linux Docker Engine **28+**, isolated internal bridges, CPU/memory/PID enforcement, and Compose with `up --wait`. Older/incompatible daemons fail with `UNSUPPORTED_DOCKER` before resource creation. See Docker's [isolated bridge mode](https://docs.docker.com/engine/network/port-publishing/#gateway-modes). Workloads use one private configuration network without an external gateway, IPv6 disabled, and `NET_RAW` dropped. Explicit loopback mappings remain in the manifest; host reachability and unintended-traffic denial require the actual-daemon smoke gate.

The runner recompiles allowlisted saved specs instead of executing arbitrary YAML. Original revisions stay immutable; deployments separately store their prepared manifest/digest. MySQL/MongoDB readiness uses authenticated local queries. MongoDB's `/data/configdb` is explicitly named/labeled alongside `/data/db`. Owner/configuration/policy labels are checked before reuse or stopping.

Compose receives stdin, explicit `--env-file /dev/null`, and a fresh private temporary project directory. A restricted child environment supplies fixed Docker settings and only the required decrypted generated secrets. No secret/environment file is written. Raw command errors and inspect output are not logged/persisted or returned through HTTP; errors use fixed codes/messages. This is a shared host for trusted local accounts, not a hostile multi-tenant sandbox.

| Bound                                        | Default                                  |
| -------------------------------------------- | ---------------------------------------- |
| Queue lifetime, enforced by an active runner | 15 minutes                               |
| Overall operation deadline                   | 8 minutes                                |
| Lease grace after deadline                   | 45 seconds                               |
| Image-pull command deadline                  | 5 minutes                                |
| Compose readiness wait                       | 120 seconds                              |
| Stop grace                                   | 30 seconds per container                 |
| Inspection command deadline                  | 15 seconds                               |
| Transient command stdout                     | At most 1 MiB; stderr discarded          |
| Reconciliation batch                         | 20 deployments, oldest observation first |
| Scan interval                                | 2 seconds                                |

## Capability validation recovery

Diagnosis on 2026-11-02 against Engine 28.1.1 found healthy Node/MySQL containers whose Start and subsequent Stop operations failed with `RESOURCE_CONFLICT` and pending cleanup. Docker inspect reported `CapDrop: ["CAP_NET_RAW"]`, but the runner required the literal `NET_RAW`. The final Start observation and pre-Stop validation therefore rejected containers created by the runner itself, leaving deployment state unknown.

The validator now accepts either exact spelling while still requiring the capability drop and all other ownership/policy checks. A regression test failed before the fix and passed afterward; all 11 driver tests pass. A read-only comparison against the affected live deployment confirmed that the original driver rejects it and the corrected driver reports running and ready. No live Stop, database state rewrite, or runner replacement was performed during diagnosis.

The runner uses compiled code, including in development. A human operator can apply the fix with the existing deployment configuration:

```bash
docker compose --env-file .env -f infra/docker-compose.yml -f infra/docker-compose.dev.yml up --build -d --no-deps runner
```

For production omit the development override. After replacement, reconciliation can recognize the healthy deployment; an explicit Stop can then validate and stop its containers. Historical failed operations remain history. Full disposable network/volume smoke verification is still required.

## Delete a stopped configuration

`DELETE /api/v1/configs/:id` accepts an optional UUID `Idempotency-Key` and returns **202 Accepted** for a configuration with a stopped deployment, using the same `operationId`, `statusUrl`, `pollAfterMs`, `Location`, and `Retry-After` contract as Start/Stop. Invalid keys return 400. A pending Start/Stop or a deployment not verified stopped returns 409; active generation still returns 403. No Docker work occurs in the API.

Admission locks the owner and configuration rows, stores `deletionRequestedAt`, and queues a `delete` runtime operation. Duplicate requests while deletion is pending return its existing operation. Repeating its original key returns that operation, even after completion; a fresh key retries a terminal failure. Reusing a key for another configuration/action returns 409. Start is rejected once deletion intent is recorded, including after cleanup failure; Stop remains available for recovery after a terminal failure. Pending operations are mutually exclusive.

The runner validates ownership, revision/policy labels, and stopped state again. It refuses running/restarting services or foreign network attachments, removes stopped containers without force/volume flags, removes the private network, and verifies both are absent. Missing resources are safe to retry. It then removes private config artifacts through the shared artifact volume. Only successful cleanup plus a fenced terminal transaction sets `deletedAt` and releases the saved-configuration quota. Errors, expired queue jobs, and interrupted leases leave the configuration visible with its deletion operation for an explicit retry. Reconciliation never clears a failed deletion's cleanup marker merely because containers are stopped.

Named database volumes, encrypted secrets, revisions, deployment metadata, and operation history are preserved. Explicit **Delete persistent data** remains a separate, unimplemented action; ordinary Delete never removes volumes. A completed delete operation remains owner-readable after the configuration is hidden, so a browser cannot miss its terminal result. Other runtime operations and configuration/generation reads remain hidden after deletion. Both UI controls poll only while deletion is pending or status recovery is needed, cancel on navigation, and stop after success/failure. A lost DELETE response retains its key for an explicit retry.

Never-started configurations retain the existing immediate 204/artifact-cleanup contract; repeated deletion without a matching runtime-operation key returns 404.

## Verification

`pnpm test:api` applies five committed migrations twice against disposable MySQL 8.4.11 and exercises real Nest handlers and durable operations. Routine runtime tests use a controlled driver; separate driver-policy tests reject ownership, privilege, mount, network, and limit mismatches before mutation. The real older-daemon check verifies refusal without creating workloads. A separate disposable Engine 28+ cleanup check creates an owned stopped MySQL container/network/volume, verifies container/network removal and volume preservation, repeats cleanup, then removes only its verified test volume.

`pnpm test:runtime` is an opt-in real Docker check using unique project/owner labels and the fixed catalog. It checks readiness, same-configuration connectivity, outbound/cross-configuration denial, and database persistence over Stop/Start, then removes only verified test containers/networks/volumes. It never loads repository environment files. On Engine 27.1.2 it stops at the prerequisite check without creating workloads. Successful Engine 28+ smoke verification remains necessary before declaring Docker execution complete.

Verification on 2026-11-02: all 74 backend checks passed with four migrations applied twice; workspace type checking, lint, explicit changed-code/new-document formatting, both runner Compose merge checks, and runner image build passed. The image's no-network/no-socket CLI check reported Compose v2.40.3. Actual smoke execution returned the Engine 28+ prerequisite error on Engine 27.1.2 before creating workloads. No full runner/database container boot or successful workload smoke is claimed.

Deletion follow-up verification (2026-11-02): 85 backend tests passed, including the real stopped-MySQL-container/network cleanup and named-volume preservation check; the older-Engine rejection check was skipped on Engine 28.1.1. All five migrations applied twice. All 84 frontend tests, workspace type checking/lint, the production web build, changed-code/runtime-document formatting, and production/development Compose structure checks passed. Dynamic version skips now close their test apps before skipping, so the suite terminates cleanly. These results do not claim the separate full catalog/readiness/network smoke gate or deployment of these source changes.

Container-view verification (2026-11-03): 91 backend checks passed against disposable MySQL 8.4.11, with all six committed migrations applied twice; the older-Engine rejection check was skipped on Engine 28.1.1. The real scoped Docker check additionally verified Created and Not created service observations before and after cleanup, with named-volume preservation. All 90 frontend tests passed, including container fields, state/health separation, partial observations, stale/error recovery, revision mismatch rejection, successful/failed lifecycle refreshes, pending-operation resumption, idle request counts, and navigation cancellation. Workspace type checking, lint without warnings, production web build, changed-source/document formatting, and whitespace checks passed. No application deployment, browser smoke, or full catalog/network runtime smoke was performed for this slice.
