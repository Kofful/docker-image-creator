# Generation and runtime design

## Agent contract
Input: schema version, approved catalog version, selected services and safe settings, natural language requirements, resource budget, and secret reference names. Do not transmit passwords, session material, host environment, database credentials, or API keys to the model.

Output: a JSON object containing `schemaVersion`, `services`, approved network intent, named volume declarations, warnings, and a short explanation. Services include stable logical keys, catalog image/tag IDs, typed settings, approved command argument arrays, ports, secret references, dependencies, health settings, and limits. The implementation must publish the exact runtime schema in `packages/contracts` before integrating a provider.

Allow only read-only `get_catalog` and `validate_candidate` tools. Bound steps, repairs, tokens, cost, output size, and elapsed time. Treat instructions embedded in user input/model output as data. Use cancellation and explicit failure states. A fake provider supports development and deterministic tests; a real provider must eventually complete the same flow. The agent cannot choose host paths or issue execution commands.

## Validation pipeline
1. Validate input shape, size, catalog membership, ownership of secret references, names, settings, and quotas.
2. Request structured output using the provider adapter.
3. Parse and validate against a strict versioned schema; reject extra fields and unresolved references.
4. Apply semantic policies: valid dependencies, no cycles where unsupported, unique names/ports, supported image capabilities, limits, and one stack-scoped network.
5. Compile Compose deterministically from approved templates. Never accept freeform YAML as executable truth.
6. Parse/validate the compiled artifact and run `docker compose config --quiet` in a controlled directory/environment; this complements application policy and does not start resources.
7. Display a masked preview and warnings. Save only a validated revision; generation failure creates no runnable revision.
8. On Start, recheck ownership, policy/catalog compatibility, secrets, quotas, and the exact stored digest. Revalidate the final secret-resolved artifact privately before execution. Never silently rewrite an old revision under a changed policy.

## Compose policy
Use one generated project name, one project-scoped bridge network, approved images with explicit tested tags, no fixed `container_name`, project-scoped named volumes, and bounded CPU/memory/PIDs/logging. Deny `privileged`, host PID/IPC/network modes, host devices, added dangerous capabilities, Docker sockets, bind mounts, external network/volume references, arbitrary builds, arbitrary interpolation, and unsupported Compose keys. The system sets project names, labels, and file paths; users cannot override them.

Node/Python templates need suitable long-running commands and available source/content; initially offer catalog-owned starter templates only, without host mounts or source uploads. Database templates use image-specific initialization settings, secrets, readiness checks, and persistent volumes. Declare initialization-only settings clearly: changing them does not reconfigure an existing database volume. Do not render blanket flags such as read-only filesystems for images that require writable paths; hardening must be template-tested.

Use service names and container ports for internal connections. Host ports are opt-in loopback bindings, separately reserved and checked for collisions; Docker remains authoritative if a host process races the reservation. Database ports are private by default. Health status and running process state are separate; a container without a healthcheck is not labeled healthy automatically.

## Lifecycle
Configuration state: draft or ready. Generation state: queued, running, succeeded, failed, canceled. Operation state: queued, running, succeeded, failed, canceled. Deployment observed state: absent, starting, running, degraded, stopping, stopped, failed, unknown. Define transition guards and test them; observed state comes from Docker.

Start claims the stack lease, resolves the requested revision, writes a restricted per-deployment artifact, validates, pulls approved images, runs Compose with argument arrays, inspects service states, and stores the result. A new revision applied to an existing deployment requires explicit user intent and records the newly applied revision. It must not change the running stack merely because the config was saved.

Stop uses scoped Compose stop semantics and preserves containers/volumes as appropriate for restart. Cleanup uses only verified resources for the generated project; data deletion is separate. A failed partial start reports created resources and supports scoped stop/cleanup; it does not delete database volumes automatically. Bound retries and operation deadlines. On restart or lease expiry, reconcile existing resources before retrying. Never run global prune or trust a client-supplied container ID.

## Secrets at execution
Store values with authenticated encryption and a deployment-provided key outside MySQL. Expose only placeholders in previews and exports. Materialize required secret/env files with restrictive permissions in runner-owned storage, protect against symlink/path traversal, escape Compose interpolation correctly, and delete temporary files when safe. Keep artifacts needed by active operations until recovery completes. Docker administrators and processes inside the target container may still access secrets delivered to that container; masking is not protection from the host administrator.
