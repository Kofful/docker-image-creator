# Configuration execution API

Status (2026-11-02): Start, Stop, operation polling, deployment status, durable MySQL admission, a separate private runner, and configuration-detail runtime controls are implemented as slices of milestone 5. Terminals, automatic temporary validation, and runtime resource/data deletion remain follow-ups. Real workload startup and network/volume behavior require the supported-host smoke gate below; controlled-driver API tests do not prove those Docker behaviors.

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

| Route                                | Behavior                                                                                                              |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/operations/:id`         | Owned type, revision, status, stage, fixed redacted error, cleanup marker, timestamps                                 |
| `GET /api/v1/configs/:id/deployment` | Owned applied revision, starting/running/stopping/stopped/failed/unknown state, latest operation ID, observation time |
| `POST /api/v1/configs/:id/stop`      | Bearer token, new UUID idempotency key, empty `{}` body; returns 202 and operation URL                                |

Stop verifies container ownership/policy and preserves artifacts, encrypted secrets, and named database volumes. Start reuses the configuration's stable volume names. Failed startup attempts to stop its partially started services while preserving data; unresolved cleanup is reported separately. Starting, stopping, partial running state, and unknown Docker state retain the user's slot; release requires verifying all services stopped.

User-row locking and a unique durable reservation enforce **one running configuration per user, without a global running-configuration count cap**. Two operations execute concurrently per runner process; this does not cap already running deployments. Database port reservations prevent competing configurations from claiming one host port; Docker also rejects ports held by unrelated host processes. Configuration operations serialize and idempotency survives API/runner restarts. Expired execution leases fail without replaying Start.

## Configuration detail UI

`/configs/:id` replaces the former Generation line with a runtime status label: Not started, Starting, Running, Stopping, Stopped, Failed, or Unknown. Generation progress and errors remain separate. A deployment 404 means Not started after the owned configuration has loaded; a failed status check shows Unknown and disables actions until status recovers.

One lifecycle button sits immediately left of Delete. Start uses the saved successful revision and is disabled until it exists; Stop replaces it for running, failed, or unknown deployments. Starting/Stopping show a disabled progress button. Pending operation status takes precedence over the observed deployment state. Failed or unknown deployments offer Stop until verified stopped; a rolled-back Start can show Stopped while retaining its operation error. Stop preserves persistent data.

The page checks deployment and latest-operation status on load. It polls every two seconds only while an operation is queued/running, the deployment is starting/stopping, or an action response remains unconfirmed. Once the status settles (including Running, Stopped, Failed, Unknown, or Not started), fetching stops until an explicit Start/Stop action or a page reload. An operation already in progress when the page opens is followed to completion. External exits and changes from another tab after polling stops appear on the next page load or explicit action. Transient status-request failures back off to at most thirty seconds until recovery; a manual status retry is also available. Navigation cancels timers and requests. Actions use authenticated API requests and fresh UUID idempotency keys; a lost response is retried only by an explicit click with the same key, while polling can discover the committed operation. A confirmed failed operation can be retried with a new key. Admission conflicts remain server-authoritative and appear as a recoverable error.

The detail page disables Delete when runtime status is unavailable, an action is pending/unconfirmed, or a deployment exists, including after Stop or failed Start. Its explanation makes the missing runtime-cleanup workflow explicit. A pending deletion disables Start/Stop. The list retains its generation status and existing deletion control; a runtime-related 409 now explains why deletion is unavailable.

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

## Deletion boundary

The existing artifact-only DELETE cannot safely remove runtime-backed configurations. The API returns 409 whenever a deployment record exists, including a stopped one, preserving recovery metadata/files. Never-started configurations keep the existing DELETE contract. The detail UI explains and disables runtime-backed deletion.

The accepted follow-up first requires stopped services, then removes owned containers/networks/files. Database volumes require a separate explicit **Delete persistent data** action in that workflow. Cleanup stays visible and retryable until verified complete; only then is the saved-configuration quota released. This workflow is agreed but not implemented by the Start endpoint change.

## Verification

`pnpm test:api` applies four committed migrations twice against disposable MySQL 8.4.11 and exercises real Nest handlers and durable operations. Routine runtime tests use a controlled driver; separate driver-policy tests reject ownership, privilege, mount, network, and limit mismatches before mutation. The real older-daemon check verifies refusal without creating workloads.

`pnpm test:runtime` is an opt-in real Docker check using unique project/owner labels and the fixed catalog. It checks readiness, same-configuration connectivity, outbound/cross-configuration denial, and database persistence over Stop/Start, then removes only verified test containers/networks/volumes. It never loads repository environment files. On Engine 27.1.2 it stops at the prerequisite check without creating workloads. Successful Engine 28+ smoke verification remains necessary before declaring Docker execution complete.

Verification on 2026-11-02: all 74 backend checks passed with four migrations applied twice; workspace type checking, lint, explicit changed-code/new-document formatting, both runner Compose merge checks, and runner image build passed. The image's no-network/no-socket CLI check reported Compose v2.40.3. Actual smoke execution returned the Engine 28+ prerequisite error on Engine 27.1.2 before creating workloads. No full runner/database container boot or successful workload smoke is claimed.
