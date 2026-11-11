# Compose policy, version 2

All new configurations use `format: llm-compose`, schema/policy version 2 and catalog version 1. Shared contracts are in `packages/contracts/src/compose.ts`; exact policy constants/allowlists are in `apps/api/src/configs/compose.policy.ts`. The model must author every required setting. Validation never injects defaults into YAML.

## Pinned catalog

| Family  | Image                          | Service port |
| ------- | ------------------------------ | ------------ |
| Node.js | `node:22.23.4-bookworm-slim`   | 8000         |
| Python  | `python:3.13.18-slim-bookworm` | 8000         |
| MySQL   | `mysql:8.4.11`                 | 3306         |
| MongoDB | `mongo:8.0.17`                 | 27017        |

## Allowed document

| Area             | Requirement                                                                                                                                                                                                                                    |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Structure        | One UTF-8 mapping document, at most 1 MiB. Top-level `name`, `services`, `networks`, optional required `volumes` only. Reject unknown fields recursively, duplicate keys, directives/tags, aliases/anchors/merges and code fences.             |
| Identity         | Exact server project `dic-<configId>`, requested service set (1–4), pinned images, settings and ownership labels. No model-chosen resource identities.                                                                                         |
| Service defaults | `init: true`, `restart: "no"`, `networks: [stack]`, `cap_drop: [NET_RAW]`, `cpus: 0.5`, `mem_limit: 512m`, `pids_limit: 128`.                                                                                                                  |
| Logs             | `json-file`, `max-size: 5m`, `max-file: "2"`.                                                                                                                                                                                                  |
| Ownership        | `docker-image-creator` labels: managed=`runtime`, user/config/policy=`2`; containers additionally bind revision. Networks/volumes omit revision for stable data identity. No extra labels.                                                     |
| Network          | Exactly one `stack` bridge: `internal: true`, `enable_ipv6: false`, IPv4 gateway mode `isolated`, exact labels. No external/default/extra networks, custom names or options.                                                                   |
| Publication      | No `ports`; creation rejects `hostPort`. Access uses service DNS/container ports and authenticated exec terminals.                                                                                                                             |
| Storage          | Only required named volumes: MySQL `<service>-data` → `/var/lib/mysql`; MongoDB `<service>-data` → `/data/db` and `<service>-configdb` → `/data/configdb`. Long mount syntax, `type: volume`, `read_only: false`, labels only on declarations. |
| Environment      | String mapping. Each declared binding uses its exact `${DIC_SECRET_<32 lowercase hex>:?Required value}`. Only validated public database/user defaults may be literal. No inherited/undeclared variables or secret literals.                    |
| Commands         | Optional nonempty string argument arrays. Use image tools/standard libraries only; no entrypoint override, installers/downloaders, companion files or builds.                                                                                  |
| Health           | Required `CMD` + arguments or `CMD-SHELL` + one expression. Interval/timeout `5s`, retries `24`, start period `10s`; no disabled health check.                                                                                                 |
| Dependencies     | Requested services only, mapping with `condition: service_healthy`; no self-reference or cycles.                                                                                                                                               |
| Host access      | Reject privileged mode, extra capabilities, host namespaces/networking, devices, bind/socket mounts, build contexts, profiles/hooks/includes/extensions and environment files.                                                                 |

Container-side dollars must be `$$` in authored commands/health checks. Opaque interpolation is allowed only in its assigned environment entries. Container names such as `PATH`/`DOCKER_HOST` cannot replace runner process settings.

The revision envelope also binds owner/config/revision identity, digest and derived metadata. Matching a header/digest alone never permits execution: [saved validation](compose-validation.md) repeats full YAML/policy checks against independently stored requirements/bindings. Legacy versions are rejected without conversion/deletion.

`pnpm test:compose-contract` checks envelope/integrity; `pnpm test:compose-validation` exercises positive/adversarial fixtures. Neither requires inference or Docker. Static acceptance cannot prove command behavior or meaningful health; runtime observation and independent evaluation probes remain necessary. This policy targets trusted users on a dedicated host.
