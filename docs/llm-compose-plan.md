# Direct LLM Compose generation and supplied secrets

Status: implementation started on 2026-11-05. Step 1 is implemented and verified: shared version 2 contracts, revision format/scope/digest checks, catalog extraction, policy constants and fixture, and aligned agent instructions. See the [policy contract](compose-policy.md). Step 2 adds [creation-time values and binding flow](supplied-environment.md). Step 3 adds [OpenRouter adapter](openrouter-adapter.md). Step 4 adds [strict validation and exact artifact persistence](compose-validation.md). Step 5 integrates saved execution and enables version 2 creation/generation in source. Step 6 adds the [terminal evaluator and ten executable cases](evaluation/terminal-runner.md). Step 7, the live benchmark and deployment remain pending. Q10 supersedes the earlier compatibility recommendation: existing template-generated configurations are unsupported after activation. Q11–Q12 are accepted. [ADR 0004](adr/0004-direct-llm-compose-generation.md) records the decision.

## Requirements supplied by the user

- Call OpenRouter using exactly `google/gemma-4-26b-a4b-it:free` to generate the Compose document directly.
- Remove the procedural service-spec-to-Compose generation path from new generation and execution. Replacing only the fake provider is insufficient.
- Let users specify which secrets and other environment variables their services require and supply their values.
- Supply the provider API key from operator-managed `.env` configuration. Keep credentials on the server; agents must not read or load the protected file. Document the variable in the secret-free example and pass it explicitly to the API process through infrastructure configuration.
- Evaluate model generation on ten test cases and count how many generated configurations start healthy. See the accepted [evaluation plan](llm-compose-evaluation.md) and [ten cases](evaluation/compose-cases.md).

## Accepted decisions

- **Q1 — Model freedom:** keep the four supported image families, pinned approved tags, and current execution isolation/resource restrictions. The model writes commands, health checks, dependencies, and service/environment wiring within that policy.
- **Q2 — Confidentiality:** accept supplied secret values through the application, but send the model only their names, purposes, service assignments, and placeholders. Encrypt stored values and inject them at runtime; exclude them from prompts, previews, and logs.
- **Q3 — Creation UI:** retain explicit service selection, interpret Instructions through the LLM, and add per-service environment entries with names, values, purposes, and shared-value references.
- **Q4 — Failure behavior:** allow at most one model repair for invalid output/policy violations in ordinary product generation. Bound transient provider retries by the generation deadline. Do not fall back to procedural output or paid models.
- **Q5/Q10 — Legacy cutoff:** existing template-generated configurations are unsupported after the switch. Remove legacy compilation, runtime regeneration, and conversion work from this milestone. Existing records or volumes are not implicitly authorized for deletion.
- **Q6 — Evaluation interface:** testing only, invoked through a terminal command. Print every case result and aggregate scores in the terminal and write file reports. Do not store evaluation results in the database or add an evaluation UI.
- **Q7 — Evaluation criteria:** report policy acceptance, healthy startup, and independent task success separately. Readiness is bounded to 120 seconds followed by ten seconds remaining healthy; retain timings, available token usage, and classified failures.
- **Q8 — Test cases:** use the ten defined cases covering individual images, supplied/shared/distinct secrets, service connectivity, persistence, special characters, and all four services together.
- **Q9 — Baseline:** one generation request per case, first-response scoring, frozen fixtures. Measure any repaired-output experiment separately.
- **Q11 — Editing scope:** support creation-time environment/secret input and shared references. General saved-revision editing, history/export workflows, secret rotation, and legacy conversion are deferred or excluded.
- **Q12 — Missing bindings:** require values for all declared bindings before generation. Reject undeclared secret references introduced by the model; product generation may use the agreed one repair. Do not invent passwords or add a second input stage after generation.
- **2026-11-05 runtime clarification — Published ports:** retain the internal isolated bridge and reject host publication. Real Docker testing exposed that this network does not publish loopback ports. This supersedes prior explicit-port requirements. The API rejects `hostPort` and model output must omit `ports`.

## Current implementation constraints

The original fake JSON provider, service compiler and runtime renderer have been removed. Generation saves complete model output after strict validation. Runtime, observations and terminals share saved-document validation; only version 2 jobs/configurations are admitted for execution. Private supplied values are encrypted separately and injected only under opaque references. Operator upgrade prerequisites are in [saved execution](saved-compose-runtime.md). No legacy data is converted or automatically deleted.

## Implementation steps and acceptance gates

Implement these as independently verifiable slices of milestone 4. Steps 1–5 are integrated in source; deployment remains an explicit operator step after draining legacy work. Earlier step verification paragraphs record the staged gates at that time.

### 1. Define the new revision and validation contract

Implemented: `packages/contracts/src/compose.ts`, `compose.policy.ts`, `compose.revision.ts`, and the hand-authored `direct-compose.yaml` fixture. The new candidate reader rejects legacy versions and verifies identity/digest while keeping YAML and derived metadata untrusted. Step 5 now integrates it with full YAML validation in generation/runtime. Nine contract tests, API/contracts/web type checks, targeted lint, formatting, and whitespace checks passed; no Docker or model call was made. Full YAML validation remains step 4.

Introduce an explicit revision/input format version that distinguishes new model-authored Compose from unsupported legacy records. Shared transport types describe service requirements, named environment values, service bindings, safe generation status, and provider/model metadata. The new executable source is the accepted Compose text, its digest, policy version, and derived lifecycle metadata; it is not a generated intermediate service specification.

Specify a strict Compose subset. Retain the existing pinned catalog, one private isolated bridge per configuration, ownership labels, named database volumes, no published ports, resource/log limits, and explicit Start. Supply required server-owned identities and policy settings to the model so it authors the complete runtime-ready document. Align the compiler instruction in `AGENTS.md` with this accepted direct-Compose design when implementation begins.

Gate: new/legacy format discrimination, shared contracts, and policy fixtures are explicit; legacy revisions cannot enter the new execution path. No compatibility compiler or conversion path is introduced.

### 2. Add creation-time values and secret bindings

Implemented: shared completeness rules, nested DTO validation, migration-backed encrypted supplied values and scoped shared bindings, value-free provider requirements, keyed idempotency, and masked Vue inputs with explicit reveal/multiline editing. The authenticated capability remains disabled until steps 3–5 are integrated, and the legacy worker excludes version 2 jobs. Verification passed: eight migrations deployed/replayed on disposable MySQL, 102 backend checks (one host-specific skip), 107 frontend checks, nine contract checks, type checks/lint, and the production web build. See [input/storage behavior and verification](supplied-environment.md).

Add Prisma migrations for encrypted supplied values and their configuration/service bindings. Retain explicit service selectors and add per-service name/value/purpose inputs plus shared-value references. Validate required database credentials and all declared bindings before enqueueing generation. Keep supplied values outside public configuration/service JSON, browser persistence, prompts, logs, and exported artifacts. General editing and password rotation are outside this slice.

Use opaque server-controlled interpolation references. A container environment name such as `PATH` or `DOCKER_HOST` must not become a runner process environment key. Preserve values exactly, including dollar signs, quotes, whitespace, and backslashes; reject unsupported input rather than reinterpret it.

Gate: disposable MySQL migration replay and owner-scoped API tests prove encrypted persistence, required-value checks, shared bindings, idempotency, and no returned plaintext. UI checks cover masking, shared-value entry, completeness, and errors.

### 3. Implement the selected model adapter

Implemented: typed direct-Compose provider, fixed OpenRouter endpoint/free model/zero price ceilings, value-free versioned prompt, bounded HTTP/response handling, safe errors and metadata, cancellation/transient retries, and one static-feedback product repair under a shared five-minute deadline. The adapter was initially separate during staging; step 5 removes the fake provider and enables the integrated version 2 path. All 29 mocked provider checks and nine contract checks passed, along with workspace type checks/lint, formatting, and Compose environment-boundary checks. No credentials, live inference, database, or Docker daemon were used. See [adapter details and limits](openrouter-adapter.md).

Implement OpenRouter behind `GenerationProvider`, using exactly `google/gemma-4-26b-a4b-it:free`. Read `OPENROUTER_API_KEY` from process environment supplied by operator-managed infrastructure configuration; document a placeholder in `.env.example`. Do not add implicit dotenv loading or expose the key to the frontend, workloads, or Docker child processes.

Send service requirements, instructions, binding metadata, and the versioned policy contract. Request one complete Compose YAML document directly. Keep the five-minute generation deadline and bounded output/cancellation. Allow one content repair after validation failure in product generation, with redacted validation feedback and bounded transient retries within the same deadline. Record actual provider/model identity rather than the current hardcoded `fake` flag. A missing key or unavailable model produces an explicit failure, without fallback generation.

Gate: mocked HTTP tests cover exact endpoint/model/request construction, value/key exclusion, valid YAML output, missing credentials, provider failures/rate limiting, empty/truncated/oversized output, cancellation, and the one-repair bound. Routine tests make no inference calls.

### 4. Validate and persist actual model output

Implemented: strict YAML 1.2/AST/policy validation, derived metadata and saved-artifact revalidation, gated version 2 queue integration, encrypted bounded capture of both content responses, persisted provider/model/usage metadata, and exact DB/file/digest publication with ownership/lease/deadline fencing. The version 2 path never calls the legacy compiler or creates passwords. This was gated until step 5 integration. Verification passed: 88 policy checks, 29 provider checks, nine contract checks, 107 frontend checks, 118 backend checks with one supported-host skip, all nine migrations deployed/replayed, type checking, lint and formatting. See [validation, persistence and verification](compose-validation.md).

Replace `parseCandidate` and `compileCompose` in generation with a strict YAML/policy validator. Reject malformed or multiple documents, duplicate keys, unsupported tags/aliases/merge behavior, unknown fields, unsafe host access, unapproved images/mounts/networks, identity changes, and undeclared interpolation references. Validate service requirements and bindings against the request. Model-authored commands and health checks may use the approved images' available libraries/tools; custom builds and dependency installation remain excluded.

Save the accepted document without rebuilding it from metadata or injecting missing settings into its YAML. Missing policy settings require model repair or failure. Derive service/image/port/volume metadata for lifecycle checks and UI observations. Preserve the durable queue, encrypted bounded response capture, immutable revision, atomic artifact publication, idempotency, ownership, and fenced success transaction. Successful generation still reports runtime validation not performed.

Gate: adversarial fixtures prove rejection before execution; accepted artifact bytes and digest match the model-authored document. Rejected/expired attempts cannot publish executable revisions, leak supplied values, or trigger Docker actions.

### 5. Execute saved Compose without regeneration

Implemented: shared saved-revision validation, exact deployment/execution bytes, policy 2 inspection/derived volumes, private supplied-value injection, terminal validation and unsupported legacy exclusion. Version 2 creation/queue processing are enabled together; fake/compiler generation and runtime regeneration are removed. See [execution boundary and verification](saved-compose-runtime.md).

Change Start/Stop, reconciliation, deletion, observations, and terminal authorization/cleanup to use the stored new-format document, digest, and validated derived metadata. Revalidate policy and bindings before execution. Remove runtime calls to `compileCompose`/`runtimeManifest`; update driver assumptions that currently depend on fixed template output. Only the runner accesses Docker, using the saved document, fixed executable/argument arrays, restricted child environment, and private value injection.

Gate: scoped disposable Docker tests prove a newly model-authored revision can Start, become ready, support terminal access, Stop, and Start again with data retained; ownership, concurrency, network isolation, rollback, and cleanup checks still hold. Saved and executed document bytes are the same. Unsupported legacy revisions cannot Start or obtain terminal access.

### 6. Build the terminal evaluation and ten executable cases

Implemented: `pnpm eval:compose`, ten fixed task inputs and trusted probes, first-response scoring, terminal/file checkpoints, secret-free recovery artifacts and cleanup-only recovery. Twenty deterministic evaluator checks and the real four-image probe/lifecycle test passed without inference or a database. See [runner usage and evidence](evaluation/terminal-runner.md).

Implement `pnpm eval:compose` as a testing-only command using the same adapter, validator, and runner execution code, with in-memory orchestration instead of application database persistence. Convert the [ten accepted tasks](evaluation/compose-cases.md) into fixed prompts, fixture inputs, and trusted independent probes. Run one request per case, sequentially, without repair or template substitution.

Print every case's policy/readiness/assertion results, timing, available usage, failure category, and cleanup outcome; print all three aggregate counts out of ten. Write matching `terminal.log` and checkpointed `results.json` files under `.runtime/evaluations/<runId>/`. Use disposable test values/resources, keep secrets out of reports, and verify scoped cleanup including test-only volumes and interruption recovery. Observe 120-second readiness plus ten seconds healthy; independently test behavior rather than trust model-authored health checks.

Gate: mocked-provider evaluator tests prove all ten cases are represented, scores/statuses are correct, terminal/file results agree, partial runs survive interruption, reports contain no secret values, and no database is required. Real-model benchmark results are measured honestly; a model failure is a result, not permission to substitute Compose or omit a case. No 100% model pass-rate threshold was requested.

### 7. Complete verification and the unsupported-legacy cutoff

Run relevant formatting/lint/type checks, mocked provider/policy tests, disposable MySQL integration, frontend checks, and scoped real-Docker lifecycle/evaluation checks. Run the live ten-case benchmark only with operator-supplied process configuration that respects protected environment-file restrictions; report actual scores and any blocked prerequisites. This planning session does not configure credentials, run inference, or access protected environment files.

Before upgrading a deployed installation, drain old generation/runtime jobs and stop legacy workloads/terminals using the existing version. The new version marks old configurations unsupported and never claims their jobs, recompiles their specifications, converts their Compose, or manages their deployments through a compatibility branch. Retain legacy records/files/volumes without automatic deletion; deleting old data is a separate operator action, not part of this implementation.

Gate: operator documentation covers configuration, reports, cutoff requirements, and actual verification limits. Code/docs no longer advertise legacy restart support or the procedural generator as a production fallback. No application deployment or destructive legacy cleanup is implied by completing these implementation steps.

## Design closure

The interview frontier is empty: the user accepted the generation/evaluation boundaries, rejected legacy compatibility, and accepted creation-only values plus pre-generation completeness checks. The user subsequently authorized implementation. Work proceeds one verifiable slice at a time; steps 1–6 are implemented and step 7 (final verification and the live benchmark) is next. Source activation is integrated; operator deployment and final benchmark verification remain separate.

## Verified provider references

Checked on 2026-11-05: OpenRouter lists the [requested Gemma model](https://openrouter.ai/google/gemma-4-26b-a4b-it:free) with free input/output pricing. Availability and account limits are not guarantees; the integration must handle [rate limits and provider errors](https://openrouter.ai/docs/api_reference/limits). The [API reference](https://openrouter.ai/docs/api_reference/overview) documents Chat Completions and bearer authentication. No credential was accessed and no inference request was made during planning.
