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
| TerminalSession            | User/session/deployment/service IDs, connection state, creation/expiry/end times; no keystroke or output history                                                                                                                                                                                       |

Enforce `(configId, version)` uniqueness, scope idempotency keys by owner and action, and enforce operation serialization transactionally. Store service definitions in the revision spec; service instances are observed runtime records. Secret references needed by retained revisions must not be deleted implicitly.

## REST outline

Auth, liveness, the configuration routes above, and [runtime Start/Stop/operation/deployment/service-observation routes](runtime-api.md) are implemented. Per-service summaries currently use the nullable `Deployment.serviceObservations` JSON snapshot added by migration `20261103000000_service_observations`; a separate ServiceInstance model remains planned. Stopped-resource deletion is implemented through the runner. Catalog, revision mutation/history, export, explicit volume deletion, and terminals remain planned. Prefix routes with `/api/v1`. Registration, login, refresh, and minimal liveness do not require an access token; refresh requires a valid refresh token. Protected routes use `Authorization: Bearer <access_token>`. Scope lookups by owner and return 404 for invisible resources. See [authentication](authentication.md) for its exact payloads/errors.

| Method and path                                   | Result                                                                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/register`                             | Create email/password account and return access/refresh tokens (201)                                                            |
| `POST /auth/login`                                | Verify credentials and return a new session's token pair (200)                                                                  |
| `POST /auth/refresh_token`                        | Consume refresh token and return rotated pair (200); replay revokes session                                                     |
| `POST /auth/logout`                               | Revoke authenticated session and all its tokens (204); terminal cleanup remains planned                                         |
| `GET /auth/me`                                    | Return minimal current user                                                                                                     |
| `GET /catalog/images`                             | Approved images, tags, settings schemas, capabilities                                                                           |
| `POST /generations` (planned alias)               | Implemented: validate builder input and queue generation; return 202 with an action ID; Docker trial remains planned            |
| `GET /generations/:id`                            | Implemented: owned generation stage/status, runtimeValidation not_performed, and redacted failure                               |
| `GET /configs`                                    | Paginated owned configs and deployment summary                                                                                  |
| `POST /configs`                                   | Implemented: save a configuration and queue background generation; return 202 immediately                                       |
| `GET /configs/:id`                                | Config, selected revision, masked preview, deployment                                                                           |
| `POST /configs/:id/revisions`                     | Save validated edited/generated specification as a new revision                                                                 |
| `GET /configs/:id/revisions`                      | Revision history                                                                                                                |
| `GET /configs/:id/export`                         | Compose artifact with secret placeholders and setup instructions                                                                |
| `POST /configs/:id/start`                         | Explicit revision ID + idempotency key; return 202 and operation ID                                                             |
| `POST /configs/:id/stop`                          | Return 202; preserve volumes                                                                                                    |
| `GET /operations/:id`                             | Owned operation progress/result                                                                                                 |
| `GET /configs/:id/services`                       | Implemented: applied-revision service names/images, observed states/health, verified loopback ports, and observation times      |
| `GET /configs/:id/services/:serviceId/logs`       | Bounded, redacted service logs                                                                                                  |
| `POST /configs/:id/services/:serviceId/terminals` | Authorize running service and issue short-lived one-use connection ticket                                                       |
| `DELETE /configs/:id`                             | Implemented: generation 403; no deployment 204; stopped deployment 202/runner cleanup; active runtime 409; volume data retained |
| `POST /configs/:id/delete-data`                   | Separate confirmed scoped volume deletion operation                                                                             |

Exact payload schemas and error envelopes belong in `packages/contracts` during implementation. Generation input never contains plaintext secrets: secret values are submitted through a protected API boundary, stored encrypted, and referenced by opaque ID. The server revalidates proposals on save and on start. Long operations return IDs for polling; request cancellation does not imply a Docker operation was canceled.

The accepted runtime deletion workflow requires stopped services, removes owned resources, and uses a separate explicit persistent-data deletion action. Cleanup remains visible/retryable until verified complete before releasing saved-configuration quota. Stopped-resource cleanup is implemented; `deletionRequestedAt` prevents Start through failed/partial cleanup, and owned delete-operation status remains readable after success. Explicit volume deletion remains planned. Runtime admission is one reserved configuration per user without a global count quota, independent of generation's two-slot queue; partial/unknown state retains that reservation. See [runtime API](runtime-api.md).

## Terminal protocol

Planned: authorize terminal creation over bearer-authenticated HTTP, then upgrade using a one-use ticket transmitted without URL query logging and an Origin check. Tickets are short-lived, bound to the user, token session, service, and deployment, and consumed atomically. Browser WebSockets cannot set arbitrary Authorization headers; design that handshake during milestone 6. Do not put reusable bearer credentials in URLs.

Client messages: `input` with bounded text, `resize` with validated rows/columns, `disconnect`. Server messages: `ready`, `output`, `exit`, `error`. Establish a TTY-backed Docker exec session using a fixed supported shell selected from the catalog. Apply backpressure, frame limits, idle/max lifetime limits, periodic authorization checks, and connection quotas. Close on logout, session expiry, ownership loss, service stop, or runner disconnect. Disconnect must clean up the exec transport/process without stopping the service's main process; verify shell termination behavior with integration tests.
