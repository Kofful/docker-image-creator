# Generation and runtime

[ADR 0002](adr/0002-compose-only-generation.md) records the accepted public-image, single-document approach. Custom Dockerfiles/builds from ADR 0001 are deferred. The current [configuration API](configuration-api.md) implements generation and saving with a deterministic fake. Live LLM calls and automatic Docker validation remain planned.

## Implemented generation milestone

- A Configuration has one to four Services selected from Node.js, Python, MySQL, and MongoDB. Category, runtime/language, and database engine are distinct settings. Java and additional image families remain deferred.
- `POST /configs` persists the owned configuration and encrypted generation input, then returns 202 with a generation ID. Replays with the same owner-scoped idempotency key return the original job; changed input returns 409.
- A background API worker claims MySQL jobs through transactions and two durable global slots. Per-user admission allows one queued/running job; a user may retain at most 20 configurations.
- The provider returns a strict service specification. The fake preserves selected settings without interpreting prose or making network calls. Provider tools cannot execute Docker, shell, filesystem, or database operations.
- Returned output is encrypted and retained before validation, including rejected output. Parse/schema/catalog checks reject unknown fields, changed image/settings selections, arbitrary commands, mounts, or build instructions. Responses over 1 MiB fail with marked bounded/truncated capture.
- The compiler creates Compose from approved public image tags and fixed executable/argument templates. Node/Python run small HTTP starters with included libraries; databases use stock images. Inline non-secret code/configuration is allowed, but no additional authored source files or Dockerfile are generated.
- Compose uses JSON formatting, a valid YAML 1.2 subset. UUID paths, 0700 directories, 0600 files, symlink checks, a flushed temporary file, and rename protect artifact writes. Only after the file is saved do the immutable initial revision and successful job status commit together.
- Failed generation retains database evidence and removes uncommitted files. Incomplete cleanup is recorded and retried. Queued jobs survive restart; expired running leases fail and are fenced from publication rather than silently calling the provider again.
- Vue creation/list/detail views use short authenticated requests and poll until terminal status. Temporary network/server failures retry with backoff without another submission. Navigation cancels polling, not the persisted job; reopening resumes status checks.

Generation `succeeded` currently means a DB revision and Compose file were saved. Responses explicitly report `provider: "fake"` and `runtimeValidation: "not_performed"`. This must not be presented as working real-provider integration or a successful Docker trial.

## Implemented limits

| Limit                                           | Default                                       |
| ----------------------------------------------- | --------------------------------------------- |
| Services per configuration                      | 4                                             |
| Retained configurations per user                | 20                                            |
| Outstanding queued/running generations per user | 1                                             |
| Active generations sharing the MySQL database   | 2                                             |
| Generation deadline                             | 5 minutes, superseding the earlier 60 seconds |
| Lease grace after deadline                      | 30 seconds                                    |
| Queued-job lifetime                             | 15 minutes                                    |
| Worker scan interval                            | 1 second                                      |
| Returned response size                          | 1 MiB                                         |
| Optional instructions                           | 16,000 characters                             |
| Browser HTTP request deadline                   | 10 seconds per request                        |
| Browser status interval / maximum retry backoff | 2 seconds / 30 seconds                        |
| Overall browser polling deadline                | None; server owns job deadlines               |

Full request validation, artifact layout, error handling, and test commands are in [configuration API](configuration-api.md).

## Compose and secret policy

Templates currently set project identities, config/revision labels, one ordinary project-scoped bridge network, and named database volumes. Generated services never join the application's infrastructure network. The agreed execution policy additionally requires denial of workload access to the internet, application infrastructure, host services, and other configurations; current bridge generation alone does not implement this policy. All services have 0.5 CPU, 512 MiB memory, 128 PIDs, and bounded JSON logging (two 5 MiB files). Four services therefore fit the agreed 2 CPU/2 GiB aggregate runtime budget; these settings are not proof of actual Docker enforcement until the runner is tested.

Deny privileged mode, host namespaces/networking, devices, Docker sockets, arbitrary bind mounts, external networks/volumes, custom container identities, source uploads, dependency installation, Dockerfiles, build contexts, and unsupported Compose fields. Host ports are opt-in loopback bindings; databases are private by default. Image tags are fixed in the compiler, and all four templates pass Compose parsing in integration tests; actual image pull/start/platform compatibility remains to be verified.

Generate database passwords outside the model and encrypt them separately. Public specs, previews, Compose files, and diagnostics contain no generated password values. Compose references required environment placeholders for the future runner to supply privately. No plaintext secret/environment file is generated now. Inputs and original responses use AES-256-GCM with record-specific authenticated context. `CONFIG_ENCRYPTION_KEY` provisioning and backup are required; rotation/multiple key versions are not implemented. Agents must not inspect protected environment files or configure real provider credentials implicitly.

## Next execution slice: manual deployments

The [runtime API](runtime-api.md) implements Start/Stop/status, configuration-detail runtime controls, and a private runner included in the default Compose stack, subject to supported-host Docker verification. Run user services alongside application containers through that runner, as recorded in [ADR 0003](adr/0003-shared-host-execution.md), for trusted local accounts. Start launches a lasting deployment and checks template-specific readiness; Stop preserves data for the next Start. Generation still saves revisions without invoking Docker. Deletion now removes stopped containers/networks/artifacts through the runner while preserving volumes. Per-service status/log routes, explicit persistent-data deletion, and terminals remain planned.

Agreed lifecycle rules:

- Honor saved, explicitly requested loopback host ports after checking conflicts; no automatic port exposure.
- Failed Start stops services launched by that attempt, preserves volumes and configuration files, and reports bounded diagnostics and any cleanup failures separately.
- Running workloads survive API/runner restarts. Unexpected service exits or a host reboot require an explicit Start; report observed state without automatic relaunch.
- Admit one running configuration per user with no global running-count quota. Keep the reservation through starting, stopping, partial, and unknown states until verifying all services stopped; retain per-service limits and bounded operation execution.
- DELETE rejects active/unknown deployments and queues owned stopped-resource/artifact removal. Cleanup stays visible/retryable until verified complete, then releases saved-config quota. Named volumes and recovery metadata remain preserved; explicit persistent-data deletion is still a separate future action.

Execution now recompiles existing saved specs without another generation call, applying the runtime policy, server-owned labels, stable volumes, and saved explicit ports. Immutable revisions remain unchanged; deployment manifests/digests are stored separately. Selected services/images/settings are preserved. Engine 28+ is required and the current Engine 27.1.2 is rejected; real supported-host network/readiness/data verification remains pending. Credential delivery and terminal limits remain console work.

Console follows execution: the UI opens an authenticated container shell, including the `mysql` CLI for database administration. It uses runner-managed Docker exec rather than SSH. Real LLM integration follows working execution and console flows.

## Later Docker validation slice

The longer-term target still includes an automatic temporary trial after generation, implemented separately after the manual deployment lifecycle:

1. Only the private runner accesses Docker. Recheck ownership, policy, digests, secret references, quotas, resource labels, and allowed image versions before execution. Run fixed executables with argument arrays and a restricted environment; never concatenate untrusted text into host shell commands.
2. Each trial, including explicit revalidation, gets fresh attempt-owned resources/data. It must not touch a lasting deployment or implicitly reuse its volumes.
3. Pull approved images and start the trial. Every service must pass a template-specific readiness check, then remain running for a ten-second observation period. Process state alone is not readiness. Database readiness probes are still a runner prerequisite.
4. Stop successful services and retain their files/stopped containers. Runtime validation success requires verifying that the temporary services have stopped.
5. On failure, retain the configuration in MySQL and remove only verified attempt-owned containers/networks before deleting generated files. Preserve named volumes until an explicit data-deletion action. If cleanup fails, expose `cleanup_pending` and remaining resources, retaining needed recovery files. Never use global prune or delete shared images/cache.
6. An infrastructure outage records failed verification without declaring the saved bundle invalid. Explicit revalidation may reuse the immutable bundle without another LLM call. No automatic model repair is planned initially.

Accepted runner defaults are two minutes for readiness, ten seconds for observation, 30 seconds for stop, and 64 KiB retained diagnostics per stage. Operation leases, fencing, reconciliation, disk/admission quotas, port reservations, log redaction, and cleanup must be implemented/tested with disposable resources before this phase is complete. A later lasting deployment starts explicitly after review.

## Deferred work

Select the real provider/model and complete its separately authorized credential workflow; implement bounded streaming/cancellation and a real-provider smoke test. Implement the private runner, Docker runtime validation, start/stop, revision editing/history/export, deletion, and terminal authorization in their subsequent milestones. The dedicated trusted local-host deployment boundary still applies; Docker access is privileged and is not a hostile multi-tenant sandbox.
