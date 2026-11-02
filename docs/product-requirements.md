# Product requirements

## Objective

Let an authenticated user describe a small container environment, generate a single Compose document using approved public images and fixed starters, retain the result, automatically test that its services can start, and review the outcome. Successful temporary validation runs stop their services; a lasting deployment is started explicitly and can expose interactive service terminals. See [ADR 0002](adr/0002-compose-only-generation.md) and the [generation design](generation-and-runtime.md) for accepted decisions and initial limits. Configuration creation/saving and frontend polling are implemented with a fake; the Docker validation and lasting-deployment phases remain planned.

The next slice implements manual lasting Start/Stop/status for existing configurations before automatic temporary validation. User containers run alongside the application containers through a private runner, with one isolated network per configuration and denied access to the internet and application infrastructure. A subsequent console slice opens a container shell, including the MySQL CLI for managing a generated database; SSH and a browser database GUI are unnecessary. See [ADR 0003](adr/0003-shared-host-execution.md) and the updated [execution order](implementation-plan.md).

Agreed execution behavior: one running configuration per user with no global count quota, holding the slot through pending/partial/unknown state until verified stopped. Explicit loopback ports remain available. Failed startup stops its attempt's services without deleting data; API/runner restarts preserve workloads, while service exits/host reboot require explicit Start. The agreed future Delete workflow requires stopped services and separate explicit persistent-data deletion, remains visible/retryable through cleanup failure, and releases saved-configuration quota only after verified completion. The implemented [endpoint slice](runtime-api.md) adds a temporary guard blocking artifact-only deletion of runtime-backed configurations until that cleanup exists.

## MVP screens

| Route                             | Behavior                                                                                                                   |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `/register`                       | Email and password account creation; no email verification                                                                 |
| `/login`                          | Email and password login with generic failure messages                                                                     |
| `/configs/new`                    | Service catalog, settings form, optional natural language instructions, Generate action, warnings, and masked YAML preview |
| `/configs`                        | User-owned configurations, runtime status, last operation, and start/stop/detail actions                                   |
| `/configs/:id`                    | Revision preview, service statuses, redacted logs, exposed endpoints, and connection actions                               |
| `/configs/:id/console/:serviceId` | Interactive terminal with connection status, resize, disconnect, and navigation back                                       |

Protect application routes, preserve form state on recoverable failures, show loading and empty states, and provide keyboard-accessible forms. The server remains authoritative for authentication and ownership.

## Builder inputs

For each service collect a unique DNS-safe name, catalog image/tag, environment variables or secret references, approved command arguments, working directory, optional host port mapping, named storage, resource limits, and supported health/dependency settings. Image-specific fields include application runtime version and command for Node/Python, database name/user/password for MySQL, and authentication/database options for MongoDB. Validate these through catalog templates rather than relying on the model to know image behavior.

Display how services connect by service name and container port. Default host exposure is disabled; selected host bindings use loopback for the local MVP. Named volume persistence is explicit. Provide template commands that keep application containers running; report that shell access is unavailable when an image lacks a supported shell.

Current milestone: `/configs/new`, `/configs`, and `/configs/:id` submit, list, preview and poll saved generation. List and detail pages also provide confirmed configuration deletion once generation finishes. The detail page adds one Start/Stop action left of Delete and a full runtime status label in place of the Generation line, retaining generation progress/errors separately. Starting/Stopping disable the action; failed/unknown deployments offer Stop until verified stopped. Any deployment record disables Delete with an explanation pending runtime cleanup. Provider selection, list runtime controls, logs, terminals, and edit/export remain planned. [Configuration API](configuration-api.md) defines implemented inputs; the builder fields below that exceed that contract are future scope.

## Main workflows

1. Register or log in, then create a configuration.
2. Select services and settings; optionally describe relationships to the agent.
3. Generate a strict service specification and compile a single Compose document; retain every returned response in MySQL before policy checks and execution. Return an action ID for progress polling.
4. Validate policy, build and start accepted services, check readiness and observe them for ten seconds, then stop successful services. Retain successful files/stopped containers; on failure remove attempt containers/networks and generated files, keeping database records and named volumes. Display validation and cleanup outcomes separately. Saved invalid output cannot become runnable.
5. Start the selected revision explicitly. Display asynchronous progress and per-service outcomes.
6. Connect to a running service; open an interactive shell via the web console.
7. Stop the stack, preserving data; start it again or revise it. Running revisions remain unchanged until a separate apply/start action.
8. Delete a stopped configuration. Persistent volume deletion is a separate confirmed choice.

## Acceptance criteria

- Registration/login/logout work without any mail service; expired or revoked sessions lose API and terminal access.
- A user can generate and save a Node/Python + MySQL/Mongo stack, with one shared network for that stack.
- Every service in the saved preview matches the accepted bundle; provider/policy failure creates no Docker resources. All returned output remains available in owned database records, including failed attempts.
- A validation run records success only after required services pass readiness, survive the observation period, and stop. Failed runs retain database evidence, remove generated files after scoped resource cleanup, and surface cleanup failures separately.
- Users see only their own configs, operations, logs, and consoles. Guessing another resource ID does not grant access.
- Start/stop operations produce accurate observed status, survive API restarts, and prevent conflicting concurrent changes.
- The terminal supports input, output, resize, explicit disconnect, and cleanup when a service stops or a session expires.
- Stop preserves database data; explicitly deleting volumes removes only resources owned by that stack.

## Deferred scope

Unrestricted Dockerfile instructions/build contexts, arbitrary YAML imports, private registries, uploading source trees, Git integrations, Kubernetes, remote Docker hosts, teams/sharing, billing, scheduled deployments, email flows, browser database GUIs, and hostile multi-tenant execution. One Compose document using approved public images and fixed Node/Python HTTP starters is in scope; custom Dockerfiles/builds, source files, and dependency installation are deferred. Full application development inferred from a prompt, operating-system package installation, arbitrary shell downloads, Java, and additional web-server image families are deferred. Initial workload families remain Node.js, Python, MySQL, and MongoDB.
