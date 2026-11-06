# Docker Image Creator

Status: Vue/Nest/MySQL authentication, direct LLM Compose generation, supplied encrypted environment values, private saved revisions, Start/Stop/status, scoped deletion and interactive terminals are implemented. Generation uses exactly OpenRouter `google/gemma-4-26b-a4b-it:free`; missing operator credentials fail explicitly. It saves a reviewable revision and never starts containers automatically. Live model inference and application deployment have not been verified.

[ADR 0004](adr/0004-direct-llm-compose-generation.md) and the [seven-step plan](llm-compose-plan.md) replace procedural generation/runtime recompilation. Steps 1–5 are implemented: versioned policy/contracts, supplied values, provider adapter, strict validation/persistence, and [saved Compose execution](saved-compose-runtime.md). Legacy configurations are unsupported; stop/drain them with the previous version before upgrading. No legacy data is implicitly removed. Published ports are rejected to preserve internal network isolation, as accepted during runtime testing. Step 6 is next: a terminal-only ten-case evaluation with file reports and no database persistence.

## Document map

The [configuration API](configuration-api.md) documents implemented creation, background generation, polling, persistence, file storage, and soft deletion with durable artifact cleanup.

The [runtime API](runtime-api.md) documents the implemented configuration Start/Stop endpoints, operation polling, per-user admission, default private runner service, and per-service Containers table on configuration detail. Container observations refresh on page entry and through lifecycle operations, then stop fetching when settled. Stopped deployments use asynchronous runner cleanup before the configuration is hidden; persistent database data remains preserved.

For automatic UI/API reloads in Docker, use the [development setup](local-setup.md#develop-in-docker-with-automatic-reload).

| Document                                            | Purpose                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------ |
| [Product requirements](product-requirements.md)     | Scope, screens, workflows, and acceptance criteria                       |
| [Architecture](architecture.md)                     | Workspace, services, trust boundaries, and technology choices            |
| [Data and API](data-and-api.md)                     | Persistence model, REST endpoints, and terminal protocol                 |
| [Terminal API](terminal-api.md)                     | Container shell connection, tickets, cleanup, limits and verification    |
| [Authentication API](authentication.md)             | Token payloads, rotation/revocation, migration and test commands         |
| [Generation and runtime](generation-and-runtime.md) | LLM contract, Compose policies, and lifecycle behavior                   |
| [Compose-only options](compose-only-options.md)     | Public-image and single-document alternatives currently under discussion |
| [Security](security.md)                             | Authentication, isolation, secrets, and execution controls               |
| [Implementation plan](implementation-plan.md)       | Ordered milestones and verification gates                                |
| [Skills](skills.md)                                 | Recommended coding skills and activation rules                           |
| [Local setup](local-setup.md)                       | Build/start commands, environment reference, and verification limits     |

## Planning assumptions

The single-document, public-image design is recorded in [ADR 0002](adr/0002-compose-only-generation.md), superseding custom builds from [ADR 0001](adr/0001-generated-bundles-and-validation-runs.md). [ADR 0004](adr/0004-direct-llm-compose-generation.md) now supersedes ADR 0002's structured-spec/compiler and fixed-starter generation contract. Compose generation/persistence and polling now use the direct-LLM replacement. Automatic temporary product validation remains planned. Domain terms are recorded in the [glossary](../GLOSSARY.md).

The 2026-11-01 [execution decision](adr/0003-shared-host-execution.md) places user containers alongside application containers through a private runner, with a private network per configuration. Explicit Start creates a lasting deployment; Stop preserves data. Allow one running configuration per user without a global count quota and honor explicit loopback ports. Workloads survive API/runner restarts; service exit and host reboot require explicit Start. Deletion requires stopped services and remains visible/retryable until cleanup is verified; explicit persistent-data deletion remains a separate follow-up. Browser terminals open Bash or sh with the container's permissions and return to configuration detail on exit/disconnect. No terminal idle/lifetime/count quotas are imposed. Execution and console precede live LLM integration in the [implementation plan](implementation-plan.md).

The first deployment is a local development tool on a dedicated Docker host for trusted users. A shared public execution service is outside the MVP. The UI uses English. One host, one running deployment per saved configuration, and one replica per service are sufficient initially. Registration is available without sending emails. Users explicitly start lasting deployments after review. Automatic temporary validation trials remain a later target; they are not part of the next manual lifecycle slice and are not implemented yet.

The selected provider is OpenRouter with exactly `google/gemma-4-26b-a4b-it:free`, behind the existing provider adapter. The model generates Compose directly; the application validates, saves, and executes that document without a compiler fallback. Credentials have not been configured or inspected during planning. Initial dependency and image versions are pinned in the scaffold; the full compatibility and clean-install gates remain pending.

## Reference documentation

Implementation should verify current official documentation before choosing package versions or relying on specific APIs:

- [NestJS authentication](https://docs.nestjs.com/security/authentication)
- [NestJS WebSocket gateways](https://docs.nestjs.com/websockets/gateways)
- [Vue tooling](https://vuejs.org/guide/scaling-up/tooling)
- [Docker Compose networking](https://docs.docker.com/compose/how-tos/networking/)
- [Docker daemon security](https://docs.docker.com/engine/security/)
- [Prisma and MySQL](https://www.prisma.io/docs/orm/overview/databases/mysql)

These are implementation references, not a claim that the planned design has been implemented or tested.
