# Container terminals

Connect on a running service opens `/configs/:id/console/:service` in the same tab. xterm.js connects through API to runner-managed Docker exec; this is a shell inside the selected container. Bash falls back to sh; missing shells fail explicitly and are never installed. Exec inherits container user/working directory without extra privileges or a command allowlist.

Shell exit, Ctrl+D, Disconnect, transport/auth failure, service stop, ownership loss or deployment replacement returns to configuration detail with a fixed reason. There is no automatic reconnect. Auth-ended landing performs no private config reads; page reload requires login.

Disconnect tries to terminate the shell/foreground group without stopping the main service; detached jobs may survive. Cleanup rechecks ownership/policy and is best effort under daemon outage, forced runner termination or altered in-container tools. Stop is recovery for remaining processes. Terminal input/output is never recorded.

## HTTP and WebSocket contracts

`POST /api/v1/configs/:id/services/:service/terminal-tickets` requires bearer/session/origin checks. Body is omitted or `{}`; command/container/user/environment/privilege overrides are forbidden. Return 404 for invisible configuration/service, 409 for inactive/changing deployment, 400 for malformed input and 401 for invalid authentication.

201 response, with no-store caching:

```json
{
  "ticket": "<single-use opaque token>",
  "expiresAt": "<UTC timestamp>",
  "socketPath": "/api/v1/terminal"
}
```

Tickets use 256-bit randomness, SHA-256 storage and 30-second establishment expiry. They bind user/session/configuration/applied revision/deployment operation/service. Later issuance removes expired records. Ticket expiry does not terminate an established authorized connection.

Browser upgrades same-origin `/api/v1/terminal` with exact trusted Origin, then sends `{"ticket":"…"}` as the first text message. API forwards it privately in an Authorization header. Runner atomically consumes it and checks session/owner/revision/pending operations/saved document/bindings/live container labels/policy/running state. Replay cannot open another shell. Credentials never appear in URLs/storage/subprotocols.

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

Contracts define fixed reason codes; arbitrary terminal output is never rendered as HTML or navigation text.

## Transport and authorization

API `TerminalModule` owns tickets/public relay. Runner registers `TerminalRunner`/`DockerExec` and listens only on private port 3001 `/terminal`, requiring ticket authorization and rejecting browser Origin. Default API target is `ws://runner:3001/terminal`; source uses an explicit loopback override. Nginx/Vite proxy upgrades. Private transport is unencrypted inside the trusted infrastructure bridge.

Only runner has the Docker socket. Its Node HTTP Engine API v1.48 client creates/starts/resizes/inspects a real TTY. Fixed launch/cleanup scripts run inside the verified container with server-derived PID arguments; user input travels only through exec stdin. No host shell or user-text command concatenation exists. Legacy revisions cannot obtain tickets; saved Compose is revalidated, never recompiled.

Runner rechecks session expiry/revocation, ownership/deployment identity and live policy every second without overlapping checks. Authentication/infrastructure failure closes transport. Seven-day auth-session expiry applies; routine JWT rotation does not impose terminal lifetime. Graceful runner shutdown waits for setup/cleanup before releasing database pools.

## Bounds and verification

No terminal idle/max-lifetime/count quotas are imposed, as explicitly accepted. Multiple terminals can share a container. Authentication/container limits remain.

| Bound                                     | Default                                           |
| ----------------------------------------- | ------------------------------------------------- |
| WebSocket message / input payload         | 64 KiB / 32 KiB                                   |
| Pending relay/input/output                | 1 MiB                                             |
| Docker output chunks / browser scrollback | 8 KiB / 2,000 lines                               |
| Resize                                    | 2–500 columns, 1–300 rows                         |
| Liveness                                  | 15-second ping/pong; establishment deadlines only |

Overflow closes instead of growing memory. Compression is off; clipboard OSC 52/window sequences are consumed and HTML/link/clipboard integrations disabled. Closing a terminal cannot detect/contain a container escape; trusted-host boundaries remain.

`pnpm test:api` covers real WebSocket→API→runner→Docker TTY, authorization/replay/expiry, input/resize, shell/fallback, revocation, concurrent terminals and cleanup with disposable MySQL/owned Docker resources. `pnpm test:web` covers navigation/protocol/reasons/cancellation/no reconnect using mocked sockets/rendering. [History](history.md) records passes; deployed browser end-to-end remains unverified.
