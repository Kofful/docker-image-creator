# Data and API contracts

## Planned entities
Use server-generated opaque IDs, UTC timestamps, foreign keys, and indexes for ownership and operation polling.

| Entity | Key fields and invariants |
| --- | --- |
| User | ID, normalized unique email, password hash, timestamps |
| Session | User ID, unique hashed random token, expiry, revocation; no plaintext bearer token |
| Configuration | Owner ID, name, description, current revision ID, timestamps, deletion state |
| ConfigRevision | Config ID, monotonic version, schema/policy/catalog versions, validated structured spec, masked Compose artifact, digest; immutable |
| GenerationAttempt | Owner/config ID, status, bounded redacted inputs/output diagnostics, provider/model metadata, usage, deadline |
| Secret | Owner/config ID, opaque reference, authenticated encrypted value, nonce/key version; no values in public revisions |
| Deployment | Config ID, applied revision ID, generated Compose project name, desired/observed state, last reconciliation |
| ServiceInstance | Deployment/service key, verified container ID and labels, observed status/health, last observation |
| Operation | Owner/config/revision IDs, type, status, idempotency key, attempt/fencing ID, lease owner/expiry, bounded redacted error |
| TerminalSession | User/session/deployment/service IDs, connection state, creation/expiry/end times; no keystroke or output history |

Enforce `(configId, version)` uniqueness, scope idempotency keys by owner and action, and enforce operation serialization transactionally. Store service definitions in the revision spec; service instances are observed runtime records. Secret references needed by retained revisions must not be deleted implicitly.

## REST outline
All endpoints except registration/login and minimal liveness require authentication. Prefix with `/api/v1`. Resource lookups include owner constraints; use 404 for resources not visible to the caller.

| Method and path | Result |
| --- | --- |
| `POST /auth/register` | Create email/password account |
| `POST /auth/login` | Set rotated HttpOnly session cookie |
| `POST /auth/logout` | Revoke session, clear cookie, close its terminals |
| `GET /auth/me` | Return minimal current user |
| `GET /catalog/images` | Approved images, tags, settings schemas, capabilities |
| `POST /generations` | Validate builder input and queue a bounded generation attempt |
| `GET /generations/:id` | Generation status, validated proposal or redacted failure |
| `GET /configs` | Paginated owned configs and deployment summary |
| `POST /configs` | Save validated proposal as initial immutable revision |
| `GET /configs/:id` | Config, selected revision, masked preview, deployment |
| `POST /configs/:id/revisions` | Save validated edited/generated specification as a new revision |
| `GET /configs/:id/revisions` | Revision history |
| `GET /configs/:id/export` | Compose artifact with secret placeholders and setup instructions |
| `POST /configs/:id/start` | Explicit revision ID + idempotency key; return 202 and operation ID |
| `POST /configs/:id/stop` | Return 202; preserve volumes |
| `GET /operations/:id` | Owned operation progress/result |
| `GET /configs/:id/services` | Observed statuses and approved host endpoints |
| `GET /configs/:id/services/:serviceId/logs` | Bounded, redacted service logs |
| `POST /configs/:id/services/:serviceId/terminals` | Authorize running service and issue short-lived one-use connection ticket |
| `DELETE /configs/:id` | Reject active stacks; remove metadata after scoped cleanup |
| `POST /configs/:id/delete-data` | Separate confirmed scoped volume deletion operation |

Exact payload schemas and error envelopes belong in `packages/contracts` during implementation. Generation input never contains plaintext secrets: secret values are submitted through a protected API boundary, stored encrypted, and referenced by opaque ID. The server revalidates proposals on save and on start. Long operations return IDs for polling; request cancellation does not imply a Docker operation was canceled.

## Terminal protocol
Upgrade at an owned terminal-session endpoint using the session cookie, a one-use ticket transmitted without URL query logging, and an Origin check. Tickets are short-lived, bound to the user, web session, service, and deployment, and consumed atomically. Do not put reusable bearer credentials in URLs.

Client messages: `input` with bounded text, `resize` with validated rows/columns, `disconnect`. Server messages: `ready`, `output`, `exit`, `error`. Establish a TTY-backed Docker exec session using a fixed supported shell selected from the catalog. Apply backpressure, frame limits, idle/max lifetime limits, periodic authorization checks, and connection quotas. Close on logout, session expiry, ownership loss, service stop, or runner disconnect. Disconnect must clean up the exec transport/process without stopping the service's main process; verify shell termination behavior with integration tests.
