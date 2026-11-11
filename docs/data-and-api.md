# Data and API index

Shared transport contracts live in `packages/contracts`; Prisma models stay in API. All nine committed MySQL migrations are required. REST paths below use `/api/v1`, JSON and no-store responses. Protected requests use bearer tokens plus origin checks, and return 404 for invisible owner-scoped resources.

## Persistence

| Model/group                                         | Purpose and invariant                                                                                                   |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| User, Session, RefreshToken                         | Normalized unique email, password hash, absolute session expiry/revocation, hashed rotating tokens and replay detection |
| Configuration                                       | Owner, selected services, input version, owner-scoped creation key/digest, deletion intent/state                        |
| SuppliedEnvironmentValue, ServiceEnvironmentBinding | Encrypted values with opaque references; shared bindings constrained to the same configuration                          |
| GenerationAttempt, GenerationSlot                   | Encrypted input/response capture, status/stage, safe provider metadata, deadline/lease and two durable global slots     |
| ConfigRevision                                      | Immutable accepted Compose bytes, SHA-256 digest, versioned derived metadata; rejected content never becomes executable |
| ConfigSecret                                        | Retained earlier secret/recovery records; new input uses supplied-value tables                                          |
| Deployment                                          | Applied revision/exact manifest, desired/observed state, reconciliation time and safe service-observation snapshot      |
| RuntimeOperation, RuntimeReservation                | Owner/action/revision idempotency, status, deadlines/leases/fencing and one reserved configuration per user             |
| RuntimePort                                         | Retained schema from earlier port admission; current policy rejects workload publication                                |
| TerminalTicket                                      | Hashed 30-second one-use capability bound to session/configuration/revision/operation/service                           |

MySQL is authoritative. Artifact files mirror accepted original YAML; private traces/reports are separate. Ordinary deletion hides configurations while retaining database history, encrypted recovery material and persistent workload volumes. Legacy records remain retained but unsupported. A separate ServiceInstance model and revision mutation workflows are not implemented.

## Implemented routes

| Method/path                                            | Result                                                                                                    | Reference                                                 |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `GET /health`                                          | Public API liveness                                                                                       | [Setup](local-setup.md)                                   |
| `POST /auth/register`, `/auth/login`                   | Account/session token pair                                                                                | [Authentication](authentication.md)                       |
| `POST /auth/refresh_token`                             | Atomic refresh rotation                                                                                   | [Authentication](authentication.md)                       |
| `GET /auth/me`, `POST /auth/logout`                    | Current user / session revocation                                                                         | [Authentication](authentication.md)                       |
| `GET /config-input-options`                            | Authenticated supplied-environment capability                                                             | [Values](supplied-environment.md)                         |
| `POST /configs`                                        | 202 configuration + generation ID                                                                         | [Configuration](configuration-api.md)                     |
| `GET /configs`, `/configs/:id`                         | Latest owned configurations (maximum 20) / detail and accepted revision                                   | [Configuration](configuration-api.md)                     |
| `GET /generations/:id`                                 | Owned generation progress, safe failure, runtime validation not performed                                 | [Configuration](configuration-api.md)                     |
| `POST /configs/:id/start`, `/configs/:id/stop`         | 202 durable operation                                                                                     | [Runtime](runtime-api.md)                                 |
| `GET /operations/:id`                                  | Owned operation status/result                                                                             | [Runtime](runtime-api.md)                                 |
| `GET /configs/:id/deployment`, `/configs/:id/services` | Latest aggregate/service observations from runner                                                         | [Runtime](runtime-api.md)                                 |
| `DELETE /configs/:id`                                  | Generation active: 403; never deployed: 204; stopped deployment: 202 cleanup; active/unknown runtime: 409 | [Deletion](runtime-api.md#delete-a-stopped-configuration) |
| `POST /configs/:id/services/:service/terminal-tickets` | 201 single-use terminal capability                                                                        | [Terminal](terminal-api.md)                               |

WebSocket `/api/v1/terminal` takes a ticket in its first message, then `input`, `resize`, `disconnect`; server emits `ready`, `output`, `exit`. API relays to private runner; only runner opens Docker exec. Browser credentials never enter URLs.

Catalog listing, revision mutation/history/export, service-log retrieval, explicit revalidation and production-volume deletion are deferred APIs, not available routes. Evaluation has no database entities or product endpoint; it is an [explicit terminal command](evaluation/terminal-runner.md).
