# Security plan

## Deployment boundary

MVP: a dedicated local Docker host used by trusted accounts. Containers and interactive shells execute code on that host. Resource limits, bridge networking, and app authorization reduce accidental exposure but do not make shared-host Docker safe for hostile tenants. A public service needs a separate runner isolation design, such as dedicated VMs, before deployment.

## Authentication

Implemented API source: normalized unique emails; Argon2id hashes with 19 MiB memory, two iterations and one lane, following [OWASP's minimum parameters](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html). Passwords have 12–128 character bounds and retain whitespace. Unknown accounts also perform password verification; login failures use a generic message. Registration immediately enables login; no email sending, verification, recovery links, or mail dependency.

Authentication now uses access and refresh tokens, replacing the planned opaque-cookie transport. HS256 access JWTs last at most 15 minutes, require the configured issuer/audience, and reference a MySQL session checked on every protected request. Refresh tokens have 256 bits of randomness; only SHA-256 hashes are persisted. Rotation consumes a token atomically under READ COMMITTED and retains consumed hashes. Replay revokes the session, including new tokens from a racing refresh. Seven-day session expiry is absolute; refresh does not extend it. Logout revokes the caller's session immediately without ending other sessions.

Tokens are returned in JSON and access tokens must be supplied in the Authorization header. The API does not set or authenticate cookies. The Vue client holds tokens in a private in-memory closure, outside Pinia state, browser storage, and URLs, and serializes refresh attempts. Reloads require login again. A failed refresh clears credentials; retryable logout failures retain a retry control. Cookie transport and durable browser credential storage are not implemented. Because this API does not accept ambient cookie credentials, there is no cookie CSRF token. Supplied Origins must exactly match `AUTH_TRUSTED_ORIGINS`, and cross-site Fetch Metadata is rejected; non-browser requests without Origin are allowed. CORS is not enabled. Any future cookie transport must add HttpOnly/Secure/SameSite policy and session-bound CSRF protection.

Registration, login, and refresh are limited to ten requests per minute per route and observed peer IP using Nest's in-process throttler. Counters reset on restart and are not shared across API replicas. Proxy headers are not trusted; through the scaffold Nginx proxy the limit is shared by clients behind that proxy. HTTPS is required outside loopback development; the provided infrastructure publishes only loopback HTTP. Refresh-token hashes remain for replay detection until session expiry; automated expired-session cleanup and per-user session quotas remain future work.

WebSocket authentication and terminal closure on session revocation/expiry remain planned for milestone 6. Endpoint and real database verification remain subject to the prerequisites in [local setup](local-setup.md).

## Authorization

Every resource lookup and mutation is constrained by user ownership, including generation attempts, revisions, operations, secrets, logs, terminal tickets, exports, and nested IDs. The runner independently verifies project/resource labels and internal operation provenance. Test cross-user resource substitution and changed ownership/session state during active sockets.

## Docker and agent controls

Only the runner accesses Docker. Authenticate and isolate its internal transport; do not publish it or the database to generated workloads. Deny dangerous Compose fields and arbitrary host access by construction. Reject model attempts to invoke execution tools or request secrets. Validate resource requests and dependencies before executing anything. Restrict image sources/tags to the tested catalog; image approval is not a substitute for security maintenance.

The agreed next execution slice uses the shared host, with one network per configuration. Workloads may communicate within that network but must be denied access to other configurations, application infrastructure, host services, and the internet. Image pulls are a runner responsibility and do not grant workload egress. The current compiler's ordinary bridge and optional loopback ports do not yet enforce this policy. Verify denial on the actual daemon before accepting execution readiness; terminal access itself needs no service port publication.

## Secrets and logging

API keys, database credentials, secret encryption keys, and session material are deployment configuration. Check in examples with placeholders only. Generated database passwords are separate encrypted user secrets. Do not include secret values in prompts, public specs, previews, exports, exceptions, traces, or operation logs. Redact known sensitive values from service logs on a best-effort basis; arbitrary application output may still reveal secrets. Avoid persistent terminal recording. Terminal output is untrusted: avoid unsafe HTML rendering and disable unneeded escape-sequence integrations such as clipboard writes.

## Resource and failure controls

Set per-user limits on configs, services, running stacks, generation requests, operation concurrency, terminal connections, CPU, memory, PIDs, disk/log retention, and output rates. Limit outbound generation payloads and enforce model budgets. Persist operation leases and reconcile after interruption. Protect runner directories from traversal/symlink attacks and use restrictive permissions. Start failure must not trigger broad cleanup or silent volume deletion.

The implemented runtime admission rule is one reserved configuration per user with no global running-count cap, independent of generation's two-slot queue. Hold the reservation through pending, partial, and unknown state until verified stopped. Per-service limits, deadlines, and bounded worker concurrency remain required. Failed Start stops its attempt's services while preserving data. The accepted future Delete workflow rejects running services, verifies resource ownership, requires separate explicit persistent-data deletion, and stays visible/retryable until verified cleanup completes. The current endpoint slice conservatively blocks artifact-only deletion of all runtime-backed configurations.

## Required verification

Test ownership across REST and WebSockets, CSRF/origin failures, revoked sessions, password handling, prompt injection, unknown/dangerous Compose fields, command/path/interpolation injection, concurrent operation fencing, partial starts, restart reconciliation, port conflicts, output flooding, and preservation/deletion of only project-owned volumes. Document any remaining constraints before expanding the deployment audience.
