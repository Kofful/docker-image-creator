# Docker Image Creator

Status: Vue/Nest source and three-service infrastructure Compose setup are present. The API includes email/password registration, login, rotating refresh tokens, current user, logout, Prisma migrations, and a disposable-MySQL endpoint test suite. The Vue UI now provides login/registration, a protected account page, memory-only session handling, and logout, with frontend tests. Generation, the runner, and terminals remain planned. See [local setup](local-setup.md) for verification results and prerequisites.

## Document map

| Document                                            | Purpose                                                              |
| --------------------------------------------------- | -------------------------------------------------------------------- |
| [Product requirements](product-requirements.md)     | Scope, screens, workflows, and acceptance criteria                   |
| [Architecture](architecture.md)                     | Workspace, services, trust boundaries, and technology choices        |
| [Data and API](data-and-api.md)                     | Persistence model, REST endpoints, and terminal protocol             |
| [Authentication API](authentication.md)             | Token payloads, rotation/revocation, migration and test commands     |
| [Generation and runtime](generation-and-runtime.md) | LLM contract, Compose policies, and lifecycle behavior               |
| [Security](security.md)                             | Authentication, isolation, secrets, and execution controls           |
| [Implementation plan](implementation-plan.md)       | Ordered milestones and verification gates                            |
| [Skills](skills.md)                                 | Recommended coding skills and activation rules                       |
| [Local setup](local-setup.md)                       | Build/start commands, environment reference, and verification limits |

## Planning assumptions

The first deployment is a local development tool on a dedicated Docker host for trusted users. A shared public execution service is outside the MVP. The UI uses English. One host, one running deployment per saved configuration, and one replica per service are sufficient initially. Registration is available without sending emails. Users start generated configurations explicitly after review.

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
