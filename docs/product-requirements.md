# Product requirements

## Objective

Let an authenticated user describe a small container environment, supply required environment values, and generate a single Compose document using approved public images through the configured OpenAI-compatible Modal endpoint and served model. Save the validated original document for review, then let the user explicitly start a lasting deployment and open interactive container terminals. See [ADR 0004](adr/0004-direct-llm-compose-generation.md) and the [generation design](generation-and-runtime.md). Generation, supplied values, lifecycle controls, and terminals are implemented; live inference and application deployment remain unverified.

User containers run alongside application containers through a private runner, with one isolated network per configuration and denied access to the internet and application infrastructure. The console opens a container shell, including the MySQL CLI for managing a generated database. The [ten-case evaluator](evaluation/terminal-runner.md) tests model output only when explicitly invoked through the terminal, printing and logging results without database persistence. Automatic temporary product validation remains deferred. Legacy configurations are unsupported and must be stopped/drained using the previous version before upgrading; their retained data is not automatically deleted.

Agreed execution behavior: one running configuration per user with no global count quota, holding the slot through pending/partial/unknown state until verified stopped. Published ports are rejected to preserve isolation. Failed startup stops its attempt's services without deleting data; API/runner restarts preserve workloads, while service exits/host reboot require explicit Start. The Delete workflow requires stopped services, remains visible/retryable through cleanup failure, and releases saved-configuration quota only after verified completion. The implemented [deletion follow-up](runtime-api.md#delete-a-stopped-configuration) queues runner cleanup for stopped configs and preserves persistent data. Explicit persistent-data deletion remains a separate deferred action.

## MVP screens

| Route                           | Behavior                                                                                                                 |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `/register`                     | Email and password account creation; no email verification                                                               |
| `/login`                        | Email and password login with generic failure messages                                                                   |
| `/configs/new`                  | Service selection, settings, masked environment values/shared assignments, optional instructions, and Generate action    |
| `/configs`                      | User-owned configurations, runtime status, last operation, and start/stop/detail actions                                 |
| `/configs/:id`                  | Original Compose preview with opaque references, generation status, Start/Stop/Delete, service observations, and Connect |
| `/configs/:id/console/:service` | Implemented same-tab container terminal with connection status, resize, Disconnect, and return to configuration detail   |

Protect application routes, preserve form state on recoverable failures, show loading and empty states, and provide keyboard-accessible forms. The server remains authoritative for authentication and ownership.

## Builder inputs

For each service collect a unique DNS-safe name, catalog image family/type, supported runtime/language or database name/user settings, and environment bindings. Users supply every declared value before generation, with a purpose and optional shared assignments. Mask values by default. Validate input completeness using the shared contract; send only binding metadata and opaque references to the model. Submit confidential values through the dedicated fields, never through Instructions or purposes.

The model authors commands, health checks, dependency wiring, and storage within the strict policy and pinned four-image catalog. No procedural starter or runtime compiler supplies missing settings. Services connect through private service DNS and container ports; host publication is rejected. Named volume persistence is explicit. Report that shell access is unavailable when an image lacks a supported shell.

Current implementation: `/configs/new`, `/configs`, and `/configs/:id` submit, list, preview and poll saved generation. List and detail provide confirmed deletion after generation. Configuration detail includes Start/Stop and a lifecycle label, separate generation/operation errors, verified service observations, and Connect on running service rows. Starting/Stopping disable actions; failed/unknown deployments offer Stop until verified stopped. Delete waits for runner cleanup; failures remain retryable. Active/unknown runtime state blocks deletion. Connect opens the same-tab terminal; shell exit/disconnect or connection/authentication failure returns to config detail. No terminal idle/lifetime/count quotas or automatic reconnection are introduced. Provider selection, list runtime controls, logs, and edit/export remain planned. [Configuration API](configuration-api.md) defines implemented inputs; builder fields below that exceed that contract are future scope.

The detail page's read-only Containers section lists every configured service with image/tag, observed container state, available health, and observation time. No published endpoint is advertised. It follows page-entry and Start/Stop status refreshes, then stops fetching when settled. Unknown observations and stale API results remain distinct from verified missing/exited containers; see the [container view](runtime-api.md#per-service-container-view).

## Main workflows

1. Register or log in, then create a configuration.
2. Select services and settings, supply all environment values/shared assignments, and optionally describe behavior and relationships in Instructions.
3. Queue generation and return an action ID for progress polling. Request complete Compose from the configured endpoint/model; encrypt complete responses before validation. Product generation uses one model response. Invalid output fails creation without a repair request or procedural fallback; transient transport retries remain bounded.
4. Strictly validate and save accepted original bytes and their digest as an immutable revision. Generation never starts containers. Show provider/policy failures without creating an executable revision.
5. Start the selected revision explicitly after review. Revalidate and execute its exact saved bytes with private value injection. Display asynchronous progress and per-service outcomes.
6. Connect to a running service; open an interactive shell via the web console.
7. Stop the stack, preserving data; start the same saved revision again. General revision editing and secret rotation remain deferred.
8. Delete a stopped configuration. Persistent volumes remain retained; their explicit deletion requires a separate future action.

## Acceptance criteria

- Registration/login/logout work without any mail service; expired or revoked sessions lose API and terminal access.
- A user can generate and save a Node/Python + MySQL/Mongo stack, with one shared network for that stack.
- Saved and executed Compose bytes match the validated model response; provider/policy failure creates no Docker resources. Complete returned output is retained encrypted, including rejected content. No supplied value or provider key enters the model prompt or public revision.
- The explicit terminal evaluator reports policy acceptance, healthy startup, and independent task success out of ten, with first-response scoring, bounded readiness, ten seconds healthy observation, and verified disposable cleanup. Results print to the terminal and persist in files without database records. Live scores require an actual benchmark run.
- Users see only their own configs, operations, logs, and consoles. Guessing another resource ID does not grant access.
- Start/stop operations produce accurate observed status, survive API restarts, and prevent conflicting concurrent changes.
- The terminal supports input, output, resize, explicit disconnect, and cleanup when a service stops or a session expires.
- Stop and configuration deletion preserve database data. The evaluator deletes only its verified disposable test volumes. Future product volume deletion must require separate confirmation and affect only the target stack.

## Deferred scope

Unrestricted Dockerfile instructions/build contexts, arbitrary YAML imports, private registries, uploading source trees, Git integrations, Kubernetes, remote Docker hosts, teams/sharing, billing, scheduled deployments, email flows, browser database GUIs, and hostile multi-tenant execution. Model-authored behavior uses tools and standard libraries already shipped in the approved Node.js, Python, MySQL, and MongoDB images. Additional source artifacts, dependency installation, operating-system package installation, arbitrary downloads, Java, and additional image families are deferred. Automatic product trials, revision editing/history/export, secret rotation, and explicit persistent-data deletion are also deferred.
