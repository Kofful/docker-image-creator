# Docker Image Creator

Status: Vue/Nest, MySQL authentication, durable fake generation, private saved revisions, and Vue configuration pages are present. Start/Stop/status endpoints, configuration-detail runtime controls, and a private runner included in the default Compose stack are implemented; see [runtime API](runtime-api.md) for provisioning and verification limits. The host now runs Docker 28.1.1. A capability-name validation bug affecting healthy workloads and Stop is fixed in source and verified by a read-only live comparison; deploying the rebuilt runner and full network/volume smoke verification remain pending. Asynchronous deletion of stopped configs now cleans up their containers, network, and artifacts while preserving database volumes. Live LLM integration, automatic temporary validation, explicit persistent-data deletion, and terminals remain planned.

## Document map

The [configuration API](configuration-api.md) documents implemented creation, background generation, polling, persistence, file storage, and soft deletion with durable artifact cleanup.

The [runtime API](runtime-api.md) documents the implemented configuration Start/Stop endpoints, operation polling, per-user admission, default private runner service, and per-service Containers table on configuration detail. Container observations refresh on page entry and through lifecycle operations, then stop fetching when settled. Stopped deployments use asynchronous runner cleanup before the configuration is hidden; persistent database data remains preserved.

For automatic UI/API reloads in Docker, use the [development setup](local-setup.md#develop-in-docker-with-automatic-reload).

| Document                                            | Purpose                                                                  |
| --------------------------------------------------- | ------------------------------------------------------------------------ |
| [Product requirements](product-requirements.md)     | Scope, screens, workflows, and acceptance criteria                       |
| [Architecture](architecture.md)                     | Workspace, services, trust boundaries, and technology choices            |
| [Data and API](data-and-api.md)                     | Persistence model, REST endpoints, and terminal protocol                 |
| [Authentication API](authentication.md)             | Token payloads, rotation/revocation, migration and test commands         |
| [Generation and runtime](generation-and-runtime.md) | LLM contract, Compose policies, and lifecycle behavior                   |
| [Compose-only options](compose-only-options.md)     | Public-image and single-document alternatives currently under discussion |
| [Security](security.md)                             | Authentication, isolation, secrets, and execution controls               |
| [Implementation plan](implementation-plan.md)       | Ordered milestones and verification gates                                |
| [Skills](skills.md)                                 | Recommended coding skills and activation rules                           |
| [Local setup](local-setup.md)                       | Build/start commands, environment reference, and verification limits     |

## Planning assumptions

The accepted single-document, public-image design is recorded in [ADR 0002](adr/0002-compose-only-generation.md), superseding custom builds from [ADR 0001](adr/0001-generated-bundles-and-validation-runs.md). Compose generation/persistence and polling are implemented with a fake provider. Automatic start/readiness/observation/stop remains planned for the runner milestone, and real provider/model selection is deferred. Domain terms are recorded in the [glossary](../GLOSSARY.md).

The 2026-11-01 [execution decision](adr/0003-shared-host-execution.md) places user containers alongside application containers through a private runner, with a private network per configuration. Explicit Start creates a lasting deployment; Stop preserves data. Allow one running configuration per user without a global count quota and honor explicit loopback ports. Workloads survive API/runner restarts; service exit and host reboot require explicit Start. Deletion requires stopped services and remains visible/retryable until cleanup is verified; explicit persistent-data deletion remains a separate follow-up. Browser terminals will open a container shell with the MySQL CLI available for MySQL services. Execution and console precede live LLM integration in the [implementation plan](implementation-plan.md).

The first deployment is a local development tool on a dedicated Docker host for trusted users. A shared public execution service is outside the MVP. The UI uses English. One host, one running deployment per saved configuration, and one replica per service are sufficient initially. Registration is available without sending emails. Users explicitly start lasting deployments after review. Automatic temporary validation trials remain a later target; they are not part of the next manual lifecycle slice and are not implemented yet.

The model provider and model remain undecided. The planned runtime will use a provider adapter, allowing a fake implementation for development before credentials exist. Initial dependency and image versions are pinned in the scaffold; the full compatibility and clean-install gates remain pending.

## Reference documentation

Implementation should verify current official documentation before choosing package versions or relying on specific APIs:

- [NestJS authentication](https://docs.nestjs.com/security/authentication)
- [NestJS WebSocket gateways](https://docs.nestjs.com/websockets/gateways)
- [Vue tooling](https://vuejs.org/guide/scaling-up/tooling)
- [Docker Compose networking](https://docs.docker.com/compose/how-tos/networking/)
- [Docker daemon security](https://docs.docker.com/engine/security/)
- [Prisma and MySQL](https://www.prisma.io/docs/orm/overview/databases/mysql)

These are implementation references, not a claim that the planned design has been implemented or tested.
