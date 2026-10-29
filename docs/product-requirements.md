# Product requirements

## Objective
Let an authenticated user describe a small container environment, choose images and settings, generate a Compose configuration through an LLM agent, review and save it, start it, and open terminals into its running services.

## MVP screens

| Route | Behavior |
| --- | --- |
| `/register` | Email and password account creation; no email verification |
| `/login` | Email and password login with generic failure messages |
| `/configs/new` | Service catalog, settings form, optional natural language instructions, Generate action, warnings, and masked YAML preview |
| `/configs` | User-owned configurations, runtime status, last operation, and start/stop/detail actions |
| `/configs/:id` | Revision preview, service statuses, redacted logs, exposed endpoints, and connection actions |
| `/configs/:id/console/:serviceId` | Interactive terminal with connection status, resize, disconnect, and navigation back |

Protect application routes, preserve form state on recoverable failures, show loading and empty states, and provide keyboard-accessible forms. The server remains authoritative for authentication and ownership.

## Builder inputs
For each service collect a unique DNS-safe name, catalog image/tag, environment variables or secret references, approved command arguments, working directory, optional host port mapping, named storage, resource limits, and supported health/dependency settings. Image-specific fields include application runtime version and command for Node/Python, database name/user/password for MySQL, and authentication/database options for MongoDB. Validate these through catalog templates rather than relying on the model to know image behavior.

Display how services connect by service name and container port. Default host exposure is disabled; selected host bindings use loopback for the local MVP. Named volume persistence is explicit. Provide template commands that keep application containers running; report that shell access is unavailable when an image lacks a supported shell.

## Main workflows
1. Register or log in, then create a configuration.
2. Select services and settings; optionally describe relationships to the agent.
3. Generate a structured proposal; validate it and display settings, warnings, and a YAML preview with secrets represented as references.
4. Review and save an immutable revision. An invalid proposal cannot become runnable.
5. Start the selected revision explicitly. Display asynchronous progress and per-service outcomes.
6. Connect to a running service; open an interactive shell via the web console.
7. Stop the stack, preserving data; start it again or revise it. Running revisions remain unchanged until a separate apply/start action.
8. Delete a stopped configuration. Persistent volume deletion is a separate confirmed choice.

## Acceptance criteria
- Registration/login/logout work without any mail service; expired or revoked sessions lose API and terminal access.
- A user can generate and save a Node/Python + MySQL/Mongo stack, with one shared network for that stack.
- Every service in the saved preview matches the structured validated specification; provider failure creates no Docker resources.
- Users see only their own configs, operations, logs, and consoles. Guessing another resource ID does not grant access.
- Start/stop operations produce accurate observed status, survive API restarts, and prevent conflicting concurrent changes.
- The terminal supports input, output, resize, explicit disconnect, and cleanup when a service stops or a session expires.
- Stop preserves database data; explicitly deleting volumes removes only resources owned by that stack.

## Deferred scope
Arbitrary Dockerfile generation/builds, arbitrary YAML imports, private registries, uploading source trees, Git integrations, Kubernetes, remote Docker hosts, teams/sharing, billing, scheduled deployments, email flows, browser database GUIs, and hostile multi-tenant execution. The MVP generates image selections and Compose settings; it does not build arbitrary images. Revisit Dockerfile generation as a separate reviewed milestone if required.
