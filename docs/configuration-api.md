# Configuration API

Implemented: owner-scoped creation/list/detail/deletion, durable generation/polling, encrypted supplied values/response captures, immutable direct-Compose revisions and private artifacts. Only input version 2 is accepted. Generation uses one response from the [configured SDK adapter](openai-compatible-adapter.md), without repair/fallback or Docker startup.

All routes use `/api/v1`, bearer/session/origin checks and `Cache-Control: no-store`. Invalid authentication returns 401; invisible resources return 404. Transport types are in `packages/contracts`.

## Submit and poll

```http
POST /api/v1/configs
Idempotency-Key: <UUID>
Authorization: Bearer <access-token>
Content-Type: application/json
```

```json
{
  "inputVersion": 2,
  "name": "Python and MySQL",
  "description": "My development environment",
  "instructions": "Use these selected services",
  "services": [
    { "name": "api", "type": "code", "image": "python", "language": "python" },
    { "name": "db", "type": "database", "image": "mysql", "database": "app" }
  ],
  "environmentValues": [
    {
      "key": "root",
      "value": "disposable-root-example",
      "purpose": "MySQL root"
    },
    {
      "key": "app",
      "value": "disposable-app-example",
      "purpose": "MySQL app password"
    }
  ],
  "environmentBindings": [
    { "service": "db", "name": "MYSQL_ROOT_PASSWORD", "valueKey": "root" },
    { "service": "db", "name": "MYSQL_PASSWORD", "valueKey": "app" }
  ]
}
```

| Input                             | Rule                                                                                                             |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Name / description / instructions | 1–80 / at most 500 / optional at most 16,000 characters                                                          |
| Services                          | 1–4 unique names matching `[a-z][a-z0-9-]{0,29}`                                                                 |
| Types/images                      | `code` or `web-server`: `node`/`python`; `database`: `mysql`/`mongodb`; optional language must match             |
| Database                          | `[a-z][a-z0-9_]{0,31}`, default `app`                                                                            |
| Environment                       | Both arrays required; complete bindings and values before generation; [detailed limits](supplied-environment.md) |
| Extra fields                      | Rejected, including commands, arbitrary images/mounts/builds and `hostPort`                                      |

Instructions/purposes are model-visible; confidential values belong only in `environmentValues`. Services use private DNS/container ports. Authenticated `GET /config-input-options` returns `{"suppliedEnvironment":true}`; a failed capability check blocks creation rather than falling back.

A UUID idempotency key with identical input returns the original job; changed input returns 409. Deleted configuration key replay returns 400. If omitted, a key is generated. Admission locks the user transactionally: one queued/running generation per user, at most 20 nondeleted configurations.

Creation saves configuration/job/values/bindings atomically and returns 202:

```json
{
  "configId": "<UUID>",
  "generationId": "<UUID>",
  "status": "queued",
  "statusUrl": "/api/v1/generations/<UUID>",
  "pollAfterMs": 2000
}
```

Headers include `Location` and `Retry-After: 2`. Poll `GET /generations/:id` every two seconds until succeeded/failed. States: queued → running → succeeded/failed. Stages: queued, generating, validating, writing, complete, failed. Response includes safe error/timestamps/revision, provider/model, input version, `runtimeValidation: not_performed` and `cleanupPending`.

`GET /configs/:id` returns safe inputs/status and successful revision Compose/digest/relative artifact path. Raw instructions/output, encrypted values and passwords are omitted. `GET /configs` returns latest owned configurations, maximum 20, allowing recovery after navigation/lost creation response.

Browser requests have ten-second deadlines, without an overall polling deadline. Transient failures/429/server errors back off to 30 seconds; auth/not-found stops polling. Navigation cancels client work, not the server job; reopening resumes. Lost creation responses can be retried with the same key while input is unchanged.

## Delete a configuration

Active generation returns 403; deletion does not cancel it. Configurations with deployments use [runtime deletion](runtime-api.md#delete-a-stopped-configuration): stopped → 202 cleanup; active/unknown/pending runtime → 409. Deletion stays visible/retryable until cleanup succeeds; persistent volumes remain retained.

Never-started configurations return 204 after soft deletion and durable artifact-cleanup intent. Database history/revisions/secrets are retained, configuration/generation reads become 404, quota is released, and private artifact files are removed. Missing/unowned/repeated IDs return 404; malformed UUIDs return 400. File failure still returns 204 and retries on one-second worker scans in batches of 20. Cleanup rejects symlinks and never creates directories. Publication holds the same row lock and validates lease/deletion state, preventing stale file writes after deletion.

List/detail Delete controls confirm the configuration name, disable during generation/pending actions, and retain retryable failures. Detail also requires known stopped/absent runtime state. Both follow pending runtime deletion after navigation and remove the configuration only on success. Disabled reasons/cleanup help use hover/focus tooltips with Escape dismissal. A delayed list response cannot restore a removed row.

## Worker and files

Two durable generation slots are claimed with `FOR UPDATE SKIP LOCKED`; API scans every second. Generation deadline is five minutes with 30-second lease grace; queue lifetime is 15 minutes. Expired running jobs fail rather than request another response. Inputs/complete returned output use AES-256-GCM with record-bound authenticated context. Output over 1 MiB fails with marked bounded capture. The response is captured before validation; invalid output publishes no executable revision.

Original accepted YAML is atomically flushed/renamed into:

```text
.runtime/configs/<userId>/<configId>/<revisionId>/compose.yaml
```

Directories/files use 0700/0600, server UUIDs and symlink checks. MySQL revision/success commit together under ownership/lease/deadline fencing. Rollback removes unpublished artifacts or retains cleanup intent. Docker uses `generated-configs` at `/app/.runtime/configs`, shared with runner; API has no Docker socket. No secret or auxiliary environment file is generated.

`CONFIG_ENCRYPTION_KEY` must be 32 bytes encoded as 64 hex characters; retain it with backups. Optional source artifact/log roots and inference settings are in [setup](local-setup.md). [Body logs](llm-body-logging.md) separately capture redacted HTTP attempts, including rejected responses. Editing/export and key rotation remain deferred.

## Verification

`pnpm test:api` exercises real HTTP/MySQL/file behavior, all migrations replayed, ownership, encryption, queue/idempotency/leases, cleanup and rollback with mocked inference. `pnpm test:web` covers polling, transient failures, navigation/reopening, retries and confirmed deletion. [History](history.md) records outcomes; these suites are separate from live-model scoring and deployment checks.
