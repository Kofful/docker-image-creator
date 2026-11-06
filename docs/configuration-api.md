# Configuration API

Implemented: owned MySQL configurations, immutable model-authored Compose revisions, durable OpenRouter generation, encrypted supplied values and response captures, private artifacts, polling, scoped deletion, and Vue creation/list/detail views. Generation uses exactly `google/gemma-4-26b-a4b-it:free`, with one validation repair and no procedural fallback. It does not start Docker or claim readiness. [Version 2 validation](compose-validation.md) and [saved execution](saved-compose-runtime.md) are integrated; legacy creation/execution is unsupported.

All routes use `/api/v1`, bearer access tokens, origin checks, and `Cache-Control: no-store`. Unauthorized access returns 401; another user's configuration or generation returns 404. Sessions are rechecked on each poll. Shared types are in `packages/contracts/src/index.ts`.

The later [runtime API](runtime-api.md) adds explicit Start/Stop and operation/deployment polling without changing generation behavior. For a stopped deployment, DELETE now returns 202 and delegates scoped container/network/artifact cleanup to the runner; see [runtime deletion](runtime-api.md#delete-a-stopped-configuration). Named volumes and recovery metadata are preserved. The immediate artifact-only contract below applies to never-started configurations.

## Supplied environment input foundation

Authenticated `GET /api/v1/config-input-options` returns `{ "suppliedEnvironment": true }`. Version 2 is required, including both environment arrays. See [request fields, encryption, limits and sharing](supplied-environment.md). Never put credentials in instructions or purposes.

## Submit once, then poll

`POST /api/v1/configs` accepts:

```json
{
  "inputVersion": 2,
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
  ],
  "name": "Python and MySQL",
  "description": "My development environment",
  "instructions": "Use these selected services",
  "services": [
    {
      "name": "api",
      "type": "code",
      "image": "python",
      "language": "python"
    },
    { "name": "db", "type": "database", "image": "mysql", "database": "app" }
  ]
}
```

Names are 1–80 characters, descriptions at most 500, and optional instructions at most 16,000. Submit private values only through `environmentValues`, never prose. There must be 1–4 services with unique names matching `[a-z][a-z0-9-]{0,29}`. Unknown fields are rejected, including arbitrary commands, images, mounts and builds. Service `type` is `code`, `web-server`, or `database`; the first two use `node` or `python`, and databases use `mysql` or `mongodb`. Optional language must match the runtime. Published ports are unsupported: `hostPort` is rejected with 400. All services communicate only over the private stack network. Database names match `[a-z][a-z0-9_]{0,31}` and default to `app`.

Send a UUID `Idempotency-Key` header. Reusing it with identical input returns the original job, including after completion; reusing it with changed input returns 409. Reusing a deleted configuration's key returns 400, even with identical input; use a new key to create another configuration. Omitting it creates a new server key. A user can have one queued/running attempt and at most 20 configurations that have not been deleted. Admission and deletion lock the user row transactionally, including concurrent submissions.

The endpoint saves configuration and job records in one transaction and returns **202 immediately**, without waiting for generation:

```json
{
  "configId": "<server UUID>",
  "generationId": "<server UUID>",
  "status": "queued",
  "statusUrl": "/api/v1/generations/<generation UUID>",
  "pollAfterMs": 2000
}
```

The response also includes `Location` and `Retry-After: 2`. A replay may return the job's later status. Poll `GET /api/v1/generations/:id` every two seconds until `status` is `succeeded` or `failed`. States are `queued → running → succeeded/failed`; stages include `queued`, `generating`, `validating`, `writing`, `complete`, and `failed`. Responses include a redacted error code/message, timestamps, revision ID, `provider: "openrouter"`, the selected model and `inputVersion: 2`, `runtimeValidation: "not_performed"`, and `cleanupPending`.

`GET /api/v1/configs/:id` returns name, description, safe service inputs, generation status, and the successful revision's Compose, SHA-256 digest, and relative artifact path. It never returns raw instructions, provider output, ciphertext, or passwords. `GET /api/v1/configs` lists the user's latest configurations (maximum 20), allowing recovery after navigation or a lost creation response. Deleted configurations are excluded. Revision/edit/export and explicit revalidation APIs remain planned.

The Vue client uses ten-second deadlines for individual HTTP requests, with **no overall browser polling deadline**. Temporary network errors, 429s, and server errors back off up to 30 seconds without resubmitting creation. Authorization/not-found failures stop polling. Leaving the view cancels requests/timers, not the server job. Reopening a saved configuration resumes polling. A lost creation response can be retried with the same key; the form preserves that key while its input is unchanged. Tokens remain in memory and use the existing serialized refresh flow.

## Delete a configuration

For configs with deployments, use the asynchronous [runtime deletion contract](runtime-api.md#delete-a-stopped-configuration): 202 for stopped deployments, 409 for active/unknown state or pending runtime actions, visible/retryable failures, and quota release only after verified cleanup. List/detail responses include `deletion` with the latest delete operation or null, allowing pending cleanup to resume after navigation. The following immediate 204 behavior applies only when no deployment exists.

`DELETE /api/v1/configs/:id` returns **403 Forbidden** when the owned configuration has a queued or running generation attempt. Deletion does not cancel generation.

Deletion sets `deletedAt` while retaining database records, including revision specifications and Compose text, generation attempts, and encrypted secrets. Deleted configurations disappear from lists; configuration detail and generation-status reads return 404. Local Compose artifacts and their configuration directory are physically removed using server-owned user/configuration IDs. There is no restore endpoint or database purge in this slice.

Deletion returns **204 No Content** with no body. A repeated DELETE, an unknown configuration, or another user's configuration returns **404 Not Found**. Deleted configurations no longer count toward the 20-configuration limit. Invalid UUIDs return 400, and the normal authentication/session/origin checks apply.

The database transaction commits deletion and a `cleanupPending` marker before attempting file removal. If file removal fails, the configuration remains soft-deleted and the response is still 204. The lifecycle worker retries pending cleanup on its one-second queue scans, in batches of at most 20 configurations, including after restart. An already-missing file counts as successful cleanup; cleanup never creates directories and rejects symlink roots/parents. No Docker resources or workload volumes are touched.

File publication holds the same configuration-row lock as deletion, verifies that the configuration is not deleted, and checks the generation lease before writing. This prevents an expired worker from publishing an artifact after deletion. Concurrent DELETE requests yield one 204 and subsequent 404 responses.

The Vue list offers a compact trash icon to the right of each configuration’s generation status; the detail page offers a Delete button. Both use a browser confirmation naming the configuration and explaining that it cannot be restored from the app. Buttons are disabled during queued/running generation and while a deletion request is pending. The list has a refresh action to update generation status; the detail page updates through its existing polling. A successful deletion removes the row from the list or returns from detail to the list. A 404 is treated as already removed. A 403 explains that generation is still in progress; network/server errors keep the configuration visible and allow retry. A delayed list refresh cannot restore a row deleted in that view.

The [runtime UI follow-up](runtime-api.md#configuration-detail-ui) adds Start/Stop and a runtime label to detail. Delete is also disabled until runtime status is checked, during pending/unconfirmed runtime actions, and whenever a deployment is not verified stopped. Stopped configurations can be deleted through runner cleanup. Both deletion controls explain runtime-related 409 responses; the list retains generation status and its current actions.

## Worker, persistence and files

Migration `20261030010000_configs` creates `configurations`, `generation_attempts`, `config_revisions`, `config_secrets`, and `generation_slots`. Migration `20261101000000_config_deletion` adds deletion timestamps, durable artifact-cleanup markers, and indexes. The slots table contains two durable slots; `FOR UPDATE SKIP LOCKED` transactions prevent multiple workers claiming a job or exceeding two active generations across API processes sharing the database. The current deployment still assumes one host and a shared artifact root.

The API polls the durable queue every second. Generation has a five-minute deadline, followed by a 30-second lease grace period; queued jobs expire after 15 minutes. Input and returned output use AES-256-GCM with record-bound authenticated context. Every returned response is retained before policy validation. Responses over 1 MiB fail with a marked, bounded captured portion. The adapter interprets instructions with metadata-only requirements and bounded HTTP/content retries. At most one policy repair fits inside the shared deadline.

The model authors the complete Compose document using the pinned catalog and allowlisted policy. Supplied values are encrypted separately and referenced only through opaque runner interpolation keys. No plaintext secret, Dockerfile or auxiliary environment file is written. No procedural commands/defaults are inserted; invalid output is repaired once or fails.

Artifacts are saved as:

```text
.runtime/configs/<userId>/<configId>/<revisionId>/compose.yaml
```

The original model-authored YAML bytes are preserved exactly. UUID paths are server-owned, directories use mode 0700, files mode 0600, and symlink roots/parents are rejected. A temporary file is flushed and renamed before the revision and successful job state commit together. MySQL remains authoritative. Generation failure retains encrypted response data and removes uncommitted artifacts; incomplete cleanup stays visible and is retried. Queued jobs survive restarts. Expired running leases fail rather than calling the provider again, and their deterministic artifact identity allows cleanup without publishing a stale result.

In Docker, the `generated-configs` named volume persists `/app/.runtime/configs`; production and development images provision it for the unprivileged `node` user. This is application artifact storage, separate from future generated workload volumes. No Docker socket is mounted into the API.

## Configuration and verification

Set `CONFIG_ENCRYPTION_KEY` to 32 random bytes encoded as exactly 64 hexadecimal characters through deployment configuration. Generate it with `openssl rand -hex 32` and use the full output: 32 hexadecimal characters encode only 16 bytes and are rejected. Retain the key when recreating containers, and back it up with the database. Rotation/multiple key versions are not implemented. The secret-free `.env.example` documents the variables; agents must not inspect or update private environment files. `CONFIG_ARTIFACT_ROOT` optionally sets an absolute private directory. The API requires operator-supplied `OPENROUTER_API_KEY` for inference; a missing key fails explicitly.

Use `pnpm test:web`, `pnpm test:api`, `pnpm typecheck`, `pnpm lint`, and `pnpm build`. The API test harness applies all committed migrations twice to disposable MySQL 8.4.11, tests HTTP/database/file behavior and ownership, and runs Compose parsing with `--env-file /dev/null` and explicit non-secret values. Deletion checks cover retained records, hidden reads, quota recovery, creation-key rejection, active-generation rejection, concurrent deletion/publication, missing files, and cleanup recovery after restart. It never starts generated workloads. Frontend tests exercise multi-minute polling, temporary transport failures, cancellation, idempotent creation retry, reopening saved jobs, and confirmed deletion from both pages, including cancellation, pending requests, active/failed generation, stale 404s, and retryable errors. Exact results and remaining prerequisites are recorded in [local setup](local-setup.md).
