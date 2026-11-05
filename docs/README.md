# Docker Image Creator

Status: Vue/Nest, MySQL authentication, durable fake generation, private saved revisions, and Vue configuration pages are present. Start/Stop/status, service observations, stopped-resource deletion, and container terminals through the private runner are implemented. See [runtime API](runtime-api.md) and [terminal API](terminal-api.md) for setup and verification limits. The host runs Docker 28.1.1. Deploying rebuilt application images and the full catalog/network/volume smoke gate remain pending. Live LLM integration, automatic temporary validation, and explicit persistent-data deletion remain planned.

Accepted next design: [ADR 0004](adr/0004-direct-llm-compose-generation.md) and the [seven-step implementation plan](llm-compose-plan.md) replace procedural generation/runtime recompilation with directly model-authored Compose using `google/gemma-4-26b-a4b-it:free`, add supplied environment values and shared secret bindings, and drop legacy-configuration support. The [ten-case evaluation](llm-compose-evaluation.md) runs only from the terminal, prints results, and writes report files without database persistence. Step 1's [versioned contracts and policy definition](compose-policy.md) are implemented and tested. Step 2's [creation-time values and shared bindings](supplied-environment.md) are implemented behind an integration gate. Step 3's [OpenRouter adapter and one-repair orchestration](openrouter-adapter.md) are implemented and tested with mocked HTTP. Generation/runtime integration and evaluation are pending; the existing production path remains active until the replacement is integrated.

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

The single-document, public-image design is recorded in [ADR 0002](adr/0002-compose-only-generation.md), superseding custom builds from [ADR 0001](adr/0001-generated-bundles-and-validation-runs.md). [ADR 0004](adr/0004-direct-llm-compose-generation.md) now supersedes ADR 0002's structured-spec/compiler and fixed-starter generation contract. Compose generation/persistence and polling are still implemented with the fake provider; the accepted direct-LLM replacement and automatic temporary validation are not implemented. Domain terms are recorded in the [glossary](../GLOSSARY.md).

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
