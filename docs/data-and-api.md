# Data and API contracts

Implemented configuration contracts are documented in [configuration API](configuration-api.md). Public-image-only [ADR 0002](adr/0002-compose-only-generation.md) supersedes custom builds. Current generation saves a validated specification and Compose file with a fake provider; Docker validation and real LLM integration remain planned.

## Implemented configuration routes

| Method and path        | Behavior                                                                                                                                        |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /configs`        | Save owned configuration and queued job; return 202 with generation ID, status URL, Location and Retry-After; UUID idempotency header supported |
| `GET /generations/:id` | Owned generation status/stage, redacted error, timestamps, revision ID, provider and runtime-validation flags, cleanup marker                   |
| `GET /configs/:id`     | Owned configuration, latest generation and successful initial revision with Compose, digest and relative artifact path                          |
| `GET /configs`         | Latest owned configurations, at most 20; supports job discovery/recovery                                                                        |
| `DELETE /configs/:id`  | Delete owned configuration; no deployment: 204/artifact cleanup; stopped deployment: 202/runner cleanup; active runtime: 409; generation: 403   |

Current persistence adds `Configuration`, `GenerationAttempt`, `ConfigRevision`, `ConfigSecret`, and two seeded `GenerationSlot` rows through migration `20261030010000_configs`. Migration `20261101000000_config_deletion` adds `Configuration.deletedAt` and a durable artifact-cleanup marker. Inputs, returned output and generated passwords are encrypted. `ConfigRevision` is the immutable initial revision; subsequent revision/edit/history/export and revalidation contracts remain planned. Deletion retains all database records but hides configuration and generation reads, releases quota, and rejects replay of the original creation key with 400. Current transport types are in `packages/contracts`; no ORM model is imported by the frontend.

## Implemented auth entities and planned application entities

Use server-generated opaque IDs, UTC timestamps, foreign keys, and indexes for ownership and operation polling.

| Entity                     | Key fields and invariants                                                                                                                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| User (implemented)         | ID, normalized unique email, password hash, timestamps                                                                                                                                                                                                                                                 |
| Session (implemented)      | User ID, absolute seven-day expiry, revocation, creation time; checked on every access-token request                                                                                                                                                                                                   |
| RefreshToken (implemented) | Session ID, unique SHA-256 hash, creation/consumption timestamps; consumed hashes retained for replay detection                                                                                                                                                                                        |
| Configuration              | Owner ID, name, description, current revision ID, timestamps, deletion state                                                                                                                                                                                                                           |
| ConfigRevision             | Config ID, monotonic version, schema/policy/catalog versions, accepted bundle/specification, file digests, validation result; immutable; retained failed output is not automatically an executable revision                                                                                            |
| GenerationAttempt          | Owner/config ID, status/stage, encrypted returned response/bundle retained before execution, truncation flag for size overflow, validation outcome/failure category, cleanup outcome including pending state, remaining owned resources, bounded diagnostics, provider/model metadata, usage, deadline |
| Secret                     | Owner/config ID, opaque reference, authenticated encrypted value, nonce/key version; no values in public revisions                                                                                                                                                                                     |
| Deployment                 | Config ID, applied revision ID, generated Compose project name, desired/observed state, last reconciliation                                                                                                                                                                                            |
| ServiceInstance            | Deployment/service key, verified container ID and labels, observed status/health, last observation                                                                                                                                                                                                     |
| Operation                  | Owner/config/revision IDs, type, status, idempotency key, attempt/fencing ID, lease owner/expiry, bounded redacted error                                                                                                                                                                               |
| TerminalTicket             | Implemented one-use hashed capability bound to user/session/configuration/applied revision/deployment operation/service; 30-second establishment expiry; no keystroke or output history                                                                                                                |

Enforce `(configId, version)` uniqueness, scope idempotency keys by owner and action, and enforce operation serialization transactionally. Store service definitions in the revision spec; service instances are observed runtime records. Secret references needed by retained revisions must not be deleted implicitly.

## REST outline

Auth, liveness, the configuration routes above, [runtime routes](runtime-api.md), and [container terminals](terminal-api.md) are implemented. Per-service summaries use `Deployment.serviceObservations`; a separate ServiceInstance model remains planned. Stopped-resource deletion is implemented through the runner. Catalog, revision mutation/history, export, and explicit volume deletion remain planned. Prefix routes with `/api/v1`. Registration, login, refresh, and minimal liveness do not require an access token; refresh requires a valid refresh token. Protected routes use `Authorization: Bearer <access_token>`. Scope lookups by owner and return 404 for invisible resources. See [authentication](authentication.md) for exact payloads/errors.

| Method and path                                        | Result                                                                                                                          |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/register`                                  | Create email/password account and return access/refresh tokens (201)                                                            |
| `POST /auth/login`                                     | Verify credentials and return a new session's token pair (200)                                                                  |
| `POST /auth/refresh_token`                             | Consume refresh token and return rotated pair (200); replay revokes session                                                     |
| `POST /auth/logout`                                    | Revoke authenticated session and all its tokens (204); active terminal authorization checks close its connections               |
| `GET /auth/me`                                         | Return minimal current user                                                                                                     |
| `GET /catalog/images`                                  | Approved images, tags, settings schemas, capabilities                                                                           |
| `POST /generations` (planned alias)                    | Implemented: validate builder input and queue generation; return 202 with an action ID; Docker trial remains planned            |
| `GET /generations/:id`                                 | Implemented: owned generation stage/status, runtimeValidation not_performed, and redacted failure                               |
| `GET /configs`                                         | Paginated owned configs and deployment summary                                                                                  |
| `POST /configs`                                        | Implemented: save a configuration and queue background generation; return 202 immediately                                       |
| `GET /configs/:id`                                     | Config, selected revision, masked preview, deployment                                                                           |
| `POST /configs/:id/revisions`                          | Save validated edited/generated specification as a new revision                                                                 |
| `GET /configs/:id/revisions`                           | Revision history                                                                                                                |
| `GET /configs/:id/export`                              | Compose artifact with secret placeholders and setup instructions                                                                |
| `POST /configs/:id/start`                              | Explicit revision ID + idempotency key; return 202 and operation ID                                                             |
| `POST /configs/:id/stop`                               | Return 202; preserve volumes                                                                                                    |
| `GET /operations/:id`                                  | Owned operation progress/result                                                                                                 |
| `GET /configs/:id/services`                            | Implemented: applied-revision service names/images, observed states/health, verified loopback ports, and observation times      |
| `GET /configs/:id/services/:serviceId/logs`            | Bounded, redacted service logs                                                                                                  |
| `POST /configs/:id/services/:service/terminal-tickets` | Implemented: authorize an applied service and issue a 30-second one-use connection ticket (201)                                 |
| `DELETE /configs/:id`                                  | Implemented: generation 403; no deployment 204; stopped deployment 202/runner cleanup; active runtime 409; volume data retained |
| `POST /configs/:id/delete-data`                        | Separate confirmed scoped volume deletion operation                                                                             |

Exact payload schemas and error envelopes belong in `packages/contracts` during implementation. Generation input never contains plaintext secrets: secret values are submitted through a protected API boundary, stored encrypted, and referenced by opaque ID. The server revalidates proposals on save and on start. Long operations return IDs for polling; request cancellation does not imply a Docker operation was canceled.

The accepted runtime deletion workflow requires stopped services, removes owned resources, and uses a separate explicit persistent-data deletion action. Cleanup remains visible/retryable until verified complete before releasing saved-configuration quota. Stopped-resource cleanup is implemented; `deletionRequestedAt` prevents Start through failed/partial cleanup, and owned delete-operation status remains readable after success. Explicit volume deletion remains planned. Runtime admission is one reserved configuration per user without a global count quota, independent of generation's two-slot queue; partial/unknown state retains that reservation. See [runtime API](runtime-api.md).

## Terminal protocol

Implemented: bearer-authenticated HTTP issues a hashed one-use capability. The browser upgrades `/api/v1/terminal` with an exact trusted Origin, sends the ticket in its first message, and the API relays it to the private runner for atomic consumption and live authorization. Tokens never appear in URLs. See [terminal API](terminal-api.md) for payloads, error reasons, cleanup and setup.

Client messages: `input`, `resize`, `disconnect`; server messages: `ready`, `output`, `exit` with a fixed reason. The runner establishes a real Docker exec TTY, using Bash then sh and inheriting the container user/working directory. Close and return to config detail on exit/disconnect, logout/session expiry, ownership loss, service stop or transport failure. Disconnect cleans the shell/foreground group without stopping the main service; detached work may continue. The user explicitly declined terminal idle/lifetime/count limits. Frame/pending-output bounds, existing authentication expiry and workload limits remain enforced.
