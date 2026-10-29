# Security plan

## Deployment boundary
MVP: a dedicated local Docker host used by trusted accounts. Containers and interactive shells execute code on that host. Resource limits, bridge networking, and app authorization reduce accidental exposure but do not make shared-host Docker safe for hostile tenants. A public service needs a separate runner isolation design, such as dedicated VMs, before deployment.

## Authentication
Store normalized unique emails and Argon2id password hashes with reviewed parameters. Set password bounds, generic login errors, and rate limits on registration/login and costly endpoints. Registration immediately enables login; no email sending, verification, recovery links, or mail dependency.

Use high-entropy opaque session cookies, server-side hashed token storage, finite expiry, rotation on login, and revocation on logout. Cookies use HttpOnly, SameSite, and Secure under HTTPS; any local HTTP exception must be explicit. Keep browser credentials out of localStorage. Protect state-changing requests with validated Origin plus a session-bound CSRF mechanism; configure explicit trusted origins. WebSocket handshakes and messages require equivalent session/ownership controls. Close active terminals on revocation/expiry.

## Authorization
Every resource lookup and mutation is constrained by user ownership, including generation attempts, revisions, operations, secrets, logs, terminal tickets, exports, and nested IDs. The runner independently verifies project/resource labels and internal operation provenance. Test cross-user resource substitution and changed ownership/session state during active sockets.

## Docker and agent controls
Only the runner accesses Docker. Authenticate and isolate its internal transport; do not publish it or the database to generated workloads. Deny dangerous Compose fields and arbitrary host access by construction. Reject model attempts to invoke execution tools or request secrets. Validate resource requests and dependencies before executing anything. Restrict image sources/tags to the tested catalog; image approval is not a substitute for security maintenance.

## Secrets and logging
API keys, database credentials, secret encryption keys, and session material are deployment configuration. Check in examples with placeholders only. Generated database passwords are separate encrypted user secrets. Do not include secret values in prompts, public specs, previews, exports, exceptions, traces, or operation logs. Redact known sensitive values from service logs on a best-effort basis; arbitrary application output may still reveal secrets. Avoid persistent terminal recording. Terminal output is untrusted: avoid unsafe HTML rendering and disable unneeded escape-sequence integrations such as clipboard writes.

## Resource and failure controls
Set per-user limits on configs, services, running stacks, generation requests, operation concurrency, terminal connections, CPU, memory, PIDs, disk/log retention, and output rates. Limit outbound generation payloads and enforce model budgets. Persist operation leases and reconcile after interruption. Protect runner directories from traversal/symlink attacks and use restrictive permissions. Start failure must not trigger broad cleanup or silent volume deletion.

## Required verification
Test ownership across REST and WebSockets, CSRF/origin failures, revoked sessions, password handling, prompt injection, unknown/dangerous Compose fields, command/path/interpolation injection, concurrent operation fencing, partial starts, restart reconciliation, port conflicts, output flooding, and preservation/deletion of only project-owned volumes. Document any remaining constraints before expanding the deployment audience.
