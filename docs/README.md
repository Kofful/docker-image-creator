# Docker Image Creator

Status: Vue/Nest and three-service infrastructure Compose are present, with email/password authentication and MySQL sessions. Configuration creation now queues durable background generation, saves an immutable DB revision and private Compose file, and exposes owner-scoped polling. Vue provides creation/list/detail pages that can wait for multi-minute generation, resume status checks, and delete saved configurations with confirmation. The provider is a deterministic fake; live LLM integration, Docker runtime validation, the runner, and terminals remain planned. See [configuration API](configuration-api.md) and [local setup](local-setup.md) for exact behavior and verification.

## Document map

The [configuration API](configuration-api.md) documents implemented creation, background generation, polling, persistence, file storage, and soft deletion with durable artifact cleanup.

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

The first deployment is a local development tool on a dedicated Docker host for trusted users. A shared public execution service is outside the MVP. The UI uses English. One host, one running deployment per saved configuration, and one replica per service are sufficient initially. Registration is available without sending emails. The target workflow includes an automatic temporary validation trial followed by stop; this runtime phase is not implemented yet. Users explicitly start lasting deployments after review.

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
