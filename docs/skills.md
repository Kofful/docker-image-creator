# Coding skill guidance

Skills guide repository work; they are not application dependencies. Start with `AGENTS.md`, the [documentation map](README.md) and the relevant current reference. Skill availability is session-specific; verify it rather than installing duplicates.

| Area                                  | Relevant guidance                                                                                                                                                |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI API/SDK behavior               | `openai-docs` for applicable official API references; current transport is configurable Modal-compatible Chat Completions                                        |
| Credential provisioning/live API work | Follow the applicable credential skill, but repository rules prohibit reading/loading private environment files; request a secret-free alternative when required |
| API request failure                   | Applicable troubleshooting skill; keep credentials/raw bodies out of public errors                                                                               |
| Hard bugs/design/reviews              | Repository diagnosing, design, domain and review skills when their triggers apply                                                                                |
| Tests                                 | Existing Vue/Nest/MySQL/policy/runtime suites; use TDD guidance when explicitly requested                                                                        |
| Repeated agent workflow               | Skill creation/installation only when justified and authorized; review provenance, permissions and architectural fit                                             |

The app uses an SDK adapter rather than an Agents API runtime; do not add an agent framework, unrelated plugins/hosting, alternate database, Docker socket exposure or email flows merely to use a skill. Future test/tooling additions should preserve strict shared contracts, Prisma migrations, owner isolation and disposable resource cleanup.
