# Evaluation of LLM-authored Compose

Status: evaluation decisions Q6–Q9 accepted on 2026-11-05. The user clarified that this is a testing-only terminal tool: all results must be printed and logged to files, not the database. The [terminal runner](evaluation/terminal-runner.md), ten executable tasks, independent probes, file reports, and cleanup recovery are implemented. Twenty deterministic checks and the real four-image probe smoke passed. No live model evaluation has been run. This extends the [generation plan](llm-compose-plan.md).

## Required outcome

Execute the Compose documents produced by the selected model for the [ten accepted cases](evaluation/compose-cases.md) in disposable environments and report how many start healthy. The case definitions contain inputs and independent checks, not template Compose outputs. This tool has no product UI and does not run automatically when users generate configurations.

## Scoring

Keep the following measures distinct, each with a count out of the same ten cases:

- **Policy acceptance:** the returned document parses, satisfies the allowlist and execution policy, uses only declared environment references, and contains the requested services/settings.
- **Healthy startup:** the accepted document starts every expected service, and each service reaches Docker health `healthy` within 120 seconds after startup begins, then remains running and healthy for a ten-second observation period. Pull time is measured separately.
- **Task success:** healthy startup plus all independently authored case assertions pass. A healthy but unrelated HTTP server is a task failure. An always-successful model health check cannot replace the independent probes.

Task success is the primary score: `passed cases / 10`, with healthy startup reported alongside it. Use raw counts and percentages; do not claim statistical reliability from ten examples. Also report generation latency, readiness time, available token usage, failure stage, and cleanup outcome. A model-based subjective judge is unnecessary for these objective checks.

For the first baseline, make one generation request per case and score its first complete response. Do not repair or substitute a template before measuring it. Product generation now follows the same single-response rule: invalid content fails without repair. Transient HTTP retries remain bounded and are reported separately. Keep prompts, the policy contract, model identifier, parameters, case-suite version, and evaluator version fixed and recorded so runs can be compared. Exact output is not guaranteed to repeat.

Provider errors, invalid output, policy rejection, startup failure, failed task assertions, infrastructure errors, and cases not run must have separate statuses. Provider failures do not disappear from the ten-task end-to-end result, but must not be described as bad Compose. A run interrupted by an infrastructure failure is incomplete; retain the ten-case denominator and show uncompleted cases rather than reporting a misleading smaller denominator. A policy-rejected case is never executed. A healthy case can still fail task assertions.

Cleanup is mandatory execution hygiene and has a separate outcome. Do not attribute a daemon/cleanup failure to model quality; mark the run operationally unsuccessful/incomplete and retain recovery identifiers. Stop scheduling cases if owned resources cannot be safely cleaned up. Do not publish an unqualified passing run while cleanup is pending.

## Terminal and file outputs

Use the existing runner container through `docker compose --env-file .env -f infra/docker-compose.yml exec runner node dist-evaluation/evaluation/cli.js`; see [requirements, measurements, reports, and recovery](evaluation/terminal-runner.md). This human-operator command supplies configured credentials through Compose; agent checks use `/dev/null` and explicit test settings instead. No host Node/pnpm is required. The separately invoked process reuses the provider adapter, Compose validator, and runner code without creating application database records. Model requests and report storage need no application database. Keep test values in memory and pass only private bindings to execution; never provide the model/provider key to Docker child processes or workloads.

Every case prints its ID/task, policy result, healthy-start result, each independent assertion outcome, timing, available usage, failure category, and cleanup status. The terminal also prints the final three counts/percentages and identifies failed or incomplete cases. Write the same result information to ignored per-run files under `.runtime/evaluations/<runId>/`:

- `terminal.log`: readable progress and results matching terminal output, flushed during the run.
- `results.json`: structured run metadata, per-case outcomes/assertions, aggregate counts, timings, and cleanup status; atomically checkpointed so interruptions retain completed outcomes.
- `Cxx.artifact.json`: the accepted original document/metadata and value-free requirements, written before resource creation for revalidated cleanup recovery. No supplied values are persisted.

Do not create database tables, generation/configuration/deployment records, or database-backed reports for evaluation. Do not persist secret values in report files. Operator-managed environment configuration supplies the provider key to the orchestration process; agent-run verification uses explicit test settings and must not load protected environment files.

## Execution flow

1. Explicitly invoke a separate evaluation command; do not start trial containers during ordinary user generation. Keep the exact model pin and prohibit procedural or paid-model fallbacks.
2. Preflight the supported Docker/Compose environment, resource enforcement, required pinned images, and test runner availability before spending inference requests. Image unavailability and unsupported hosts are infrastructure failures, not automatically model failures. A running application API or MySQL database is not an evaluation prerequisite.
3. Run cases sequentially with fresh test-owned user/configuration/revision resource identities, networks, and disposable data for each case. These identities are resource labels, not database records. Give the model the task, allowed image/policy contract, required resource identities, and environment binding names/purposes; keep supplied values private.
4. Capture bounded provider output and validate the actual model-authored document before any Docker action. Do not call the old JSON-spec compiler or runtime manifest generator. Derived metadata may support checks; it must not become a replacement generated Compose document.
5. Have the private runner execute that validated artifact with a restricted environment and server-controlled interpolation references. The provider key must not enter workloads or the runner's Docker command environment.
6. Observe startup and the ten-second healthy period, and execute fixed evaluator-owned assertions through scoped runner operations. Do not rely solely on model-authored health checks. HTTP/database/env probes must use fixed argument arrays, avoid host-shell interpolation, and return safe outcomes rather than secret values.
7. For the persistence case, write a harmless marker, Stop/Start the same disposable deployment without another model call, and check the marker. Preserve its volumes between those two starts only.
8. In a guaranteed cleanup path, including cancellation, stop and remove only verified case-owned containers, network, artifacts, and test volumes. The user explicitly invoking a disposable evaluation authorizes deletion of that run's test data; production volumes remain untouched. Verify absence and record any recovery needs. Never use global prune.
9. Print all per-case results and the aggregate summary, and write `terminal.log` and `results.json` as specified above. Exclude secrets, provider authorization headers, and raw inspect/container-terminal output. Keep any saved Compose artifact free of supplied secret values. Never write evaluation results to the database.

## Shared implementation and remaining verification

`apps/api/scripts/test-runtime.mjs` uses frozen authored fixtures to verify the strict validator and exact execution driver in two disposable projects. It is a lifecycle smoke, not the ten-case model evaluator or a model-quality result. The production driver waits for all services to run healthy, with a 120-second Compose readiness bound and a separate image-pull deadline. Step 5 added strict saved-document validation at the execution seam and opaque supplied-value injection; the evaluator reuses it without a database.

The implemented evaluator shares the accepted generation/validation/execution code and policy. It uses a test-only in-memory orchestration/runner entry point rather than the database-backed product job queue. `pnpm eval:compose --cleanup <runId>` retries only pending cleanup from revalidated artifacts, without a provider key or Start. The live ten-case benchmark remains a separate step 7 gate. The benchmark is separate from the still-planned product feature that would automatically validate every generated configuration through a temporary deployment.

## Accepted scope

- Testing only, explicitly invoked from the terminal, with all results both printed and written to file reports; no database persistence or evaluation UI.
- Three distinct scores, independent probes, 120-second readiness and ten-second observation limits, and classified failures.
- The ten defined cases within the four-image catalog and existing execution isolation.
- A single first-response baseline per case. Repeated runs are separate later experiments, not part of the ten-request baseline.
