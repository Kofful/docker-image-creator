# Direct Compose integration

[ADR 0004](adr/0004-direct-llm-compose-generation.md) replaced intermediate service-spec compilation with validated model-authored Compose. All seven integration slices are implemented in source. The current provider is the [configurable Modal/OpenAI SDK adapter](openai-compatible-adapter.md), and product/evaluation generation accepts one model response without content repair. These later choices supersede the ADR's original OpenRouter/repair details.

| Slice                  | Delivered boundary                                                                                                               | Acceptance evidence                                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Versioned contract  | Version 2 envelope, exact digest/identity, independent pinned catalog, policy and fixtures                                       | Legacy/unknown versions and changed identities/digests rejected; envelope alone never authorizes execution                                   |
| 2. Supplied values     | Masked creation inputs, complete/shared bindings, configuration-scoped encrypted storage, value-free provider metadata           | MySQL constraints/replay, confidentiality, exact values, idempotency and frontend completeness tested                                        |
| 3. Provider adapter    | Bounded direct-Compose request/response with configured endpoint/model and safe metadata                                         | Mocked HTTP covers secret exclusion, configuration, retries, cancellation, malformed/truncated output and no fallback                        |
| 4. Validate/persist    | Strict complete-document YAML/policy checks, encrypted capture before validation, immutable exact-byte artifact/revision         | Adversarial fixtures, DB/file/digest agreement and lease/deadline publication fencing tested                                                 |
| 5. Saved execution     | Admission, runner, observations, deletion and terminals share saved-revision validation; supplied-value injection only for Start | Four-image private-network lifecycle, exact execution, ownership, rollback, terminal access, persistence and scoped cleanup passed           |
| 6. Ten-case evaluation | Explicit terminal CLI, independent probes, three scores out of ten, file reports/recovery; no database persistence               | Deterministic evaluator and real trusted-probe smoke passed; runs inside existing runner                                                     |
| 7. Verification/cutoff | Integrated checks, operator instructions, unsupported legacy boundary and completed historical live report                       | [Verification](direct-compose-verification.md) and [history](history.md); deployment/browser checks and current-prompt benchmark remain open |

## Preserved decisions

- Node.js, Python, MySQL and MongoDB use pinned approved images. The model authors commands, health checks, dependencies and environment wiring within the policy.
- Users supply all required values before generation; shared assignments are supported. The model sees names/purposes/opaque references, never actual values. No generated passwords or second-stage secret form.
- Validate before persistence and again before execution. Preserve original YAML bytes; never patch missing settings or compile derived metadata into replacement YAML.
- Invalid content fails immediately; bounded network/HTTP retries are distinct from content repair. No procedural, alternate-model or paid fallback.
- Generation saves a reviewable revision without starting Docker. Published ports are rejected; private service networking/terminals provide access.
- Legacy configurations are unsupported, retained without conversion/deletion, and must be stopped/drained with the previous version before upgrading.
- Evaluation is explicitly invoked, first-response, ten frozen cases, terminal/file reports and no application database records. Policy, readiness and task success remain separate; cleanup is independently required.

General saved-revision editing/history/export, secret rotation, automatic product trials and explicit production-volume deletion are deferred. See [milestones](implementation-plan.md) for remaining acceptance gates rather than historical step-by-step transcripts.
