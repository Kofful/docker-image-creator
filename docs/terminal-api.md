# Container terminals

The [saved Compose execution boundary](saved-compose-runtime.md) now validates revision bytes, digest, metadata and stored bindings for tickets, ongoing authorization and shell cleanup. Legacy revisions are unsupported and cannot obtain tickets. No terminal path recompiles Compose.

The console milestone adds **Connect** to each running service row on configuration detail. It opens `/configs/:id/console/:service` in the same browser tab. Start remains a separate explicit action. The browser terminal uses xterm.js; it does not run a local or host shell.

The runner opens Bash (`/bin/bash`) when available, otherwise `/bin/sh`. Neither shell is installed automatically. A shellless image returns an explained failure to configuration detail. Exec inherits the container's configured user and working directory without granting extra privileges. Users can execute any command those permissions permit, including commands that break their own workload.

`exit`, Ctrl+D, Disconnect, connection failure, container stop, logout, authentication-session expiry, ownership loss, or deployment replacement ends the terminal and returns to configuration detail with a reason. Connect is required again; there is no automatic reconnection. When local authentication has ended, the config route shows only a sign-in notice and makes no private configuration requests. Reloading still loses the application's memory-only credentials and requires login.

Disconnect ends the interactive shell and its foreground process group while leaving the main service running. Deliberately detached jobs in other sessions may continue. Stop remains the way to stop all processes in a container. Closing the tab or navigating away also closes the terminal transport. Cleanup rechecks container ownership/policy and never stops the main container, removes volumes, or invokes a host shell. Cleanup is best effort if Docker becomes unavailable, the runner is forcibly killed, or a user removes/replaces the shell tools used for cleanup; use Stop to end remaining container processes in those cases.

No host shell exists behind the exec stream. An actual container escape is a host security incident, not a reliably detectable terminal event; redirecting a browser cannot contain one. The trusted local dedicated-host deployment boundary remains unchanged.

## HTTP and WebSocket contracts

`POST /api/v1/configs/:id/services/:service/terminal-tickets` requires the existing bearer access token and origin protection. It accepts no command, container ID, environment override, user, or privilege settings. Omit the body or send `{}`. The service key is its name in the applied revision. Invisible configuration/service IDs return 404, inactive/changing deployments return 409, malformed requests return 400, and invalid authentication returns 401.

The 201 response has `Cache-Control: no-store`:

```json
{
  "ticket": "<single-use opaque token>",
  "expiresAt": "<UTC timestamp>",
  "socketPath": "/api/v1/terminal"
}
```

Tickets contain 256 bits of randomness, expire after 30 seconds, and are stored only as SHA-256 hashes in `TerminalTicket`. They bind the user, authentication session, configuration, applied revision, deployment operation, and service. Migration `20261103010000_terminal_tickets` creates the table. Expired records are removed on later ticket issuance. Active connections retain their authorization context in runner memory; ticket expiry applies only to establishment and does not end an established terminal.

The browser upgrades same-origin `/api/v1/terminal` with an exact trusted Origin, then sends `{"ticket":"…"}` as its first text message. No ticket, bearer token, or other credential goes into a URL, browser storage, or WebSocket subprotocol. The API connects to the private runner and forwards this one-use capability in an Authorization header. The runner atomically consumes it and independently rechecks the session, ownership, applied revision, manifest/digests, pending operations, live container labels/policy, and running state before exec. A replay loses the consume race and cannot open another shell. Each later connection requires a fresh ticket.

Client messages after authentication:

```json
{"type":"input","data":"pwd\n"}
{"type":"resize","cols":101,"rows":37}
{"type":"disconnect"}
```

Server messages:

```json
{"type":"ready","shell":"/bin/bash"}
{"type":"output","data":"/app\r\n"}
{"type":"exit","reason":"shell_exited"}
```

Shared TypeScript contracts include all fixed end reasons. The configuration page maps only known reason codes to static text; arbitrary terminal output and server diagnostics are never rendered as HTML or navigation messages.

## Transport and authorization

API `TerminalModule` owns the ticket endpoint and WebSocket relay. The separate runner registers `TerminalRunner` and `DockerExec`; neither Engine provider is registered in the API. The runner listens on port 3001 only inside the infrastructure network, with no published host port. It accepts only ticket-authenticated upgrades to `/terminal` and rejects browser Origin headers. `TERMINAL_RUNNER_URL` defaults to `ws://runner:3001/terminal`; source development can explicitly select `ws://127.0.0.1:3001/terminal`. The private transport is unencrypted inside the existing trusted infrastructure network; do not expose it publicly.

The runner uses Node HTTP over `/var/run/docker.sock` with Docker Engine API v1.48 create/start/resize/inspect exec endpoints, compatible with the runtime's Engine 28+ prerequisite. Exec attaches a real TTY. Fixed executable arguments launch a shell and report its container-namespace PID privately for cleanup; user terminal input goes only to the exec stream. Cleanup uses a fixed script inside the same verified container, with server-derived PID arguments, to terminate the terminal session and foreground process group. No user text is interpolated into a host command.

Runner checks of authentication-session expiry/revocation, ownership, deployment identity, and live container policy run every second without overlapping checks. The session's existing absolute seven-day expiry applies; an access JWT's routine fifteen-minute rotation does not impose a separate terminal lifetime. Authorization/infrastructure failures close the connection. API or runner shutdown closes its sockets; graceful runner shutdown waits for pending shell setup/cleanup before releasing database pools.

## Agreed bounds

The user explicitly declined terminal idle timeouts, maximum session durations, and per-container/per-user/global terminal-count quotas. Multiple independent terminals may connect to the same container. Existing container CPU/memory/PID limits and authentication expiry remain in force.

Transport memory is bounded: 64 KiB WebSocket messages, 32 KiB input payloads, 1 MiB pending relay/input/output buffers, 8 KiB Docker output chunks, and 2,000 lines of browser scrollback. Resize accepts 2–500 columns and 1–300 rows. Slow peers/output overflow close the connection instead of growing memory without bound. Compression is disabled. A 15-second ping/pong heartbeat detects broken connections without timing out healthy idle sessions. Ticket/upgrade/startup deadlines apply only while establishing a connection. Terminal keystrokes/output are never recorded; xterm consumes clipboard OSC 52 and window-manipulation sequences and has no HTML/link/clipboard integration.

## Verification

`pnpm test:api` uses a disposable MySQL 8.4.11 database and separately labelled, bounded Node containers/private networks for real WebSocket → API → runner → Docker tests. It replays all committed migrations twice. Coverage includes ticket/owner/service/session/origin/payload rejection, atomic consume/replay/expiry, real input/output and TTY resize, shell exit, disconnect and foreground cleanup, concurrent terminals, logout/expiry, ownership changes, container stop, Bash fallback, and shellless failure. Cleanup verifies test-resource labels before removal and never touches unrelated containers/networks/volumes.

`pnpm test:web` covers authenticated ticket delivery, same-tab Connect navigation, terminal input/output/resize forwarding, explained return paths, disconnect without Stop, auth-ended landing without private requests, cancellation, no automatic reconnect, and absence of idle/duration timers. Browser component tests mock the terminal renderer/socket; real Docker transport checks do not substitute for a deployed browser end-to-end test or milestone 5's complete catalog/network/data-retention smoke gate.

Final verification on Docker Engine 28.1.1: 99 backend checks passed, one older-Engine rejection check skipped, and all 100 frontend tests passed. Seven migrations deployed twice against disposable MySQL 8.4.11. Workspace type checking, lint without warnings, production web build, targeted formatting/whitespace checks, and both Compose configurations passed. Application images have not been deployed; no real-browser end-to-end or full catalog/network/data-retention smoke was run.
