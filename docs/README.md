# Documentation map

Start with the [project README](../README.md) for local setup, system/network diagrams, evaluation cases, and results. These pages describe implemented behavior unless explicitly marked deferred or historical. Repeated implementation transcripts have been consolidated into [history](history.md).

## Repository tree

```text
docker-image-creator/
├── README.md                    App overview, quick start, diagrams, evaluation summary
├── apps/
│   ├── web/                     Vue pages, authentication client, lifecycle UI, xterm console
│   ├── api/
│   │   ├── src/auth/            Email/password, sessions, rotating tokens, request guards
│   │   ├── src/configs/         Generation queue, LLM adapter/prompt, validation, secrets/artifacts
│   │   ├── src/runtime/         Runner worker, Compose driver, reconciliation, service observations
│   │   ├── src/terminal/        Tickets, API relay, runner authorization, Docker exec
│   │   ├── prisma/             MySQL schema and nine committed migrations
│   │   ├── evaluation/         Ten-case CLI, independent probes, reports, cleanup recovery
│   │   └── test/               HTTP/MySQL, policy, provider, runtime, and terminal checks
│   └── runner/                  Separate runner package and image; worker/evaluator entry points
├── packages/contracts/          Shared TypeScript transport contracts and environment validation
├── infra/                       Base/dev Compose, Docker development image, reload smoke harness
├── .env.example                 Secret-free operator configuration template
├── GLOSSARY.md                  Domain terminology
└── docs/                        Reference pages listed below
```

## Documentation tree

```text
docs/
├── README.md                    This navigation map
├── local-setup.md               Docker/source setup, environment reference, development and checks
├── architecture.md              Components, information flow, durability, networking and storage
├── product-requirements.md      User workflows, screens, supported and deferred scope
├── security.md                  Authentication, ownership, execution, secrets and resource boundaries
├── implementation-plan.md       Milestone completion and remaining acceptance gates
├── history.md                   Consolidated implementation changes and measured results
├── data-and-api.md              Implemented persistence model and route index
├── authentication.md            Auth payloads, token rotation/revocation and browser behavior
├── configuration-api.md         Creation, polling, idempotency, artifacts and deletion
├── supplied-environment.md      Value entry, shared bindings, encryption and confidentiality limits
├── runtime-api.md               Start/Stop, observations, deletion, admission and deadlines
├── terminal-api.md              Ticket/WebSocket protocol, Docker exec, cleanup and bounds
├── generation-and-runtime.md    Generation-to-deployment workflow and deferred automatic trials
├── compose-policy.md            Version 2 YAML allowlist, pinned catalog and resource requirements
├── compose-validation.md        Strict parsing, revision integrity and publication rules
├── saved-compose-runtime.md     Exact saved-byte execution and unsupported legacy boundary
├── openai-compatible-adapter.md Current Modal endpoint/model configuration and provider limits
├── llm-body-logging.md          Private trace paths, redaction, access and retention
├── mysql-bootstrap.md           Special-character credential reference and regression evidence
├── llm-compose-plan.md          Direct-Compose integration slices and acceptance criteria
├── llm-compose-evaluation.md    Scoring rules, reproducibility and failure interpretation
├── direct-compose-verification.md  Verification scope and legacy upgrade checklist
├── evaluation/
│   ├── compose-cases.md         Ten fixed tasks and independent pass assertions
│   ├── terminal-runner.md       Container invocation, reports, cleanup/recovery and exit status
│   └── run-074b86dd.md          Historical first live baseline: 0/10 with failure breakdown
├── adr/                         Historical decisions; later amendments are in history/architecture
│   ├── 0001-generated-bundles-and-validation-runs.md  Original build/trial proposal; superseded
│   ├── 0002-compose-only-generation.md               Public images; compiler later superseded
│   ├── 0003-shared-host-execution.md                 Dedicated host and private runner
│   └── 0004-direct-llm-compose-generation.md         Exact model-authored Compose; provider/repair amended
├── compose-only-options.md      Short rationale for public images and single-document output
├── openrouter-adapter.md        Historical provider summary; no current setup instructions
└── skills.md                    Coding-agent guidance; no application runtime dependency
```

## Reading paths

| Need                          | Read                                                                                                                |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Run or develop the app        | [Setup](local-setup.md), [provider configuration](openai-compatible-adapter.md)                                     |
| Understand the implementation | [Architecture](architecture.md), [API/data index](data-and-api.md), [glossary](../GLOSSARY.md)                      |
| Change generation/execution   | [Policy](compose-policy.md), [validation](compose-validation.md), [saved execution](saved-compose-runtime.md)       |
| Run or interpret evaluation   | [Scoring](llm-compose-evaluation.md), [cases](evaluation/compose-cases.md), [runner](evaluation/terminal-runner.md) |
| Audit progress and evidence   | [Milestones](implementation-plan.md), [history](history.md), [verification](direct-compose-verification.md)         |

Current behavior uses version 2 saved Compose, prompt v5, one model response without content repair, a configurable OpenAI-compatible transport, and private networks without published workload ports. Historical ADRs and the OpenRouter baseline describe earlier choices rather than current provider configuration. Successful fixture checks are separate from live inference scores and deployment verification.
