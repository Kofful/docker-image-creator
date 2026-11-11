# Security boundaries

The deployment target is trusted accounts on a dedicated local Docker host. Generated commands and interactive shells execute code on that host. Shared-host Docker access is privileged; application authorization/resource/network checks do not provide hostile multi-tenant isolation. Public hosting requires a separate isolation design.

## Identity and ownership

Email/password authentication uses Argon2id, short-lived bearer access tokens, rotating hashed refresh tokens and absolute MySQL sessions. Every protected request checks revocation; active terminals recheck every second. Browser tokens stay in memory. Exact Origin/cross-site checks and bounded single-process auth throttling apply. See [authentication](authentication.md) for payloads/limits and proxy caveats. Only loopback HTTP is provided; nonloopback deployment requires HTTPS.

All configurations, jobs, revisions, operations, bindings, observations and terminal tickets are owner-scoped. Invisible nested IDs return 404. Runner independently verifies resource labels, revision identity and internal operation provenance before mutation/exec. Lost responses and worker retries cannot bypass idempotency/leases/fencing.

## Untrusted generation and execution

Prompts, LLM output, YAML, environment values and terminal data are untrusted. The provider sees only allowlisted metadata and has no Docker/shell/filesystem/database tools. One model response is fully validated before persistence and revalidated before execution; original accepted bytes are preserved without procedural fallback or repair.

The [policy](compose-policy.md) rejects unknown fields, image substitutions, privileged mode, host namespaces/networking, devices, arbitrary mounts/builds, sockets, external networks and publication. Only runner accesses Docker. Fixed executables/argument arrays, restricted environments, private paths and ownership-verified resources prevent user text from becoming host shell commands.

Each configuration shares one internal isolated bridge; workload access to infrastructure, host, internet and other configurations is denied under the policy and checked in scoped real-Docker tests. Registry pulls occur through runner independently. Application MySQL is never attached to a generated network. Browser terminal traffic relays through API to private runner and needs no service publication.

## Secrets and output

Supplied values use configuration/reference-bound AES-256-GCM storage and opaque interpolation names. Only Start decrypts them into declared keys in the restricted child environment. Container `PATH`/`DOCKER_HOST` cannot replace runner settings. Private values/provider credentials must stay out of model requests, public revisions/status/errors and reports; instructions/purposes are model-visible and must not contain credentials.

[Body traces](llm-body-logging.md) are private redacted diagnostic copies with 0700/0600 permissions. Headers/endpoint URLs are omitted; redaction is bounded and cannot reliably identify unlabeled confidential prose. Trace retention is operator-managed. Terminal keystrokes/output are never recorded; rendering consumes unsafe clipboard/window integrations and uses no HTML. Service-log retrieval is deferred because arbitrary application output can reveal secrets.

## Bounds and recovery

Admission limits configurations/services/generations, reserves one running configuration per user and bounds concurrent operations/deadlines. Each service gets CPU/memory/PID/log caps. Parser/output/terminal buffers and private filesystem paths are bounded. [Runtime](runtime-api.md#runner-provisioning-and-policy) and [terminal](terminal-api.md#bounds-and-verification) list actual defaults. The user explicitly declined terminal idle/lifetime/count quotas; authentication expiry and container limits remain. Host-wide disk quotas, automatic trace retention and expired-session cleanup are not implemented.

Failed Start attempts scoped rollback, retaining volumes. Stop preserves data. Ordinary Delete verifies stopped state/ownership and removes containers/network/artifacts before hiding the configuration; failed cleanup remains retryable. Production-volume deletion remains deferred. Evaluator cleanup separately verifies/deletes only its disposable volumes and halts on failure. Never use global prune.

Terminal disconnect cleanup is best effort under daemon/runner/tool failure; detached processes may survive. Stop is recovery. Browser closure cannot detect/contain a container escape.

Required checks cover authentication/revocation, REST/WebSocket owner substitution, adversarial YAML/interpolation, policy/resource bypass, concurrent starts, stale leases, partial/unknown state, isolation, buffer overflow and scoped volume retention/cleanup. [History](history.md) records evidence and remaining deployment/browser verification limits.
