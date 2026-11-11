# Terminal Compose evaluation

Body logging: every LLM HTTP attempt now writes paired redacted request/response JSON files below `<reportDirectory>/llm/<userId>/<configId>/<revisionId>/`, including HTTP errors and policy-rejected output. Each case reports `llmLogDirectory`. Bodies stay separate from terminal summaries and never enter the database. See [locations, redaction and limits](../llm-body-logging.md).

Step 6 is implemented in `apps/api/evaluation`. This is an explicitly invoked test runner. It shares the OpenAI-compatible adapter, strict Compose validator, and privileged Docker runtime driver, without booting Nest, connecting to MySQL, or creating application records. The production API does not gain Docker access. The operator supplied a [completed live baseline](run-074b86dd.md) with nine rate-limit failures, one policy rejection and task success 0/10; no generated workload started.

## Run in the existing runner

Evaluation runs as a separate, explicitly invoked process in the application's existing `runner` container. Its normal job-worker command stays unchanged; evaluation is never scheduled automatically. The runner image includes the compiled evaluator, pinned Node 22.23.4, Docker CLI and Compose. No host Node, pnpm or workspace dependencies are required. The evaluator itself boots no Nest application and makes no database connection, although the existing runner service normally uses the application database.

Use Linux Docker Engine 28+ with CPU/memory/PID enforcement and Docker Compose v2.29.1 or newer within v2. From the repository root, a human operator whose root `.env` already contains the application configuration and `OPENAI_BASE_URL`, `OPENAI_API_KEY` and `OPENAI_MODEL` first upgrades the existing runner while it has no active operations or terminals:

```bash
docker compose --env-file .env -f infra/docker-compose.yml up -d --build --no-deps runner
```

This assumes the application is already running. For the Docker development setup, include `-f infra/docker-compose.dev.yml` after the base file on these commands, using the same project name as the running application. Recreate runner after changing its endpoint, model, key or mount settings; `exec` uses the container's existing environment.

Run the benchmark in that container:

```bash
docker compose --env-file .env -f infra/docker-compose.yml exec runner node dist-evaluation/evaluation/cli.js
```

From a terminal already opened inside runner at `/app/apps/api`, use `node dist-evaluation/evaluation/cli.js` directly. Append `--help` for usage. There is no separate evaluation service, image or container.

Compose supplies the configured provider endpoint, model and key to API for generation and runner for explicitly invoked evaluation. The job worker does not use the key. The CLI never loads environment files. Agents must not inspect or load protected files; agent-run checks use explicit dummy settings and `--env-file /dev/null`. No key is built into the image or passed to Docker child processes/generated workloads. The API remains socket-free and the model-generated workloads retain the internal isolated network policy.

The command checks credentials, Docker capabilities, Compose version and all four exact catalog image pins before inference. `PROVIDER_NOT_CONFIGURED` means runner has no usable key; `DOCKER_UNAVAILABLE` means runner could not access the daemon. All ten cases remain not run after preflight failure, and zero counts are not a model-quality measurement. Use runner for Docker execution. See [verification and operator handoff](../direct-compose-verification.md).

It runs all ten cases sequentially. There is no case-selection option, repair, template substitution, alternate model, or paid fallback. The provider remains exactly `google/gemma-4-26b-a4b-it:free` with zero price ceilings and bounded transport retries. Ten logical generation calls can involve up to thirty HTTP attempts; successful responses report attempt counts and available usage. Failed requests may not provide usage/attempt metadata. Image pulls can use external registry connectivity; generated workloads remain isolated and publish no ports. Evaluation shares the existing runner's resources and daemon; run one evaluation at a time when the runner is idle.

`pnpm eval:compose` remains the internal source entry point used during development; the operator workflow above runs the precompiled entry point inside runner.

## Measurements

Each case has fresh user/configuration/revision UUIDs and in-memory disposable values. Only names, purposes, bindings, and opaque interpolation references reach the provider. The first response is policy-validated, then its original bytes and digest pass to the production driver. Pull time is separate from the driver's 120-second Compose startup wait. The evaluator checks running/healthy observations eleven times with ten one-second waits before independent assertions. Observation overhead is included in its reported duration.

Trusted probes test exact UTF-8 HTTP message bodies, DNS/TCP connections, MySQL application/root queries, failed authentication, MongoDB authenticated ping/failed authentication, and exact environment delivery/public database settings. C05/C06 additionally stop the verified database container and require `/ready` to stop returning success. C09 writes a marker, stops and starts the same artifact and volume without another provider call, then queries the marker. The [fixed suite](compose-cases.md) has executable inputs and assertions in `apps/api/evaluation/cases.ts`; it supplies no expected Compose to the model.

Probe programs are evaluator-owned, use fixed argument arrays, and return only a pass/fail sentinel. Private passwords and expected messages travel through stdin or remain in memory for comparison; they never enter command arguments or reports. The Docker child environment contains only fixed runner settings and, for Compose execution, declared opaque supplied-value keys. It never inherits the provider key. Raw provider bodies, Docker inspection, stderr, container logs, and probe output are not logged. Auth failure probes distinguish authentication rejection from a connection error.

The three scores always use ten as their denominator: policy acceptance, healthy startup, and task success. A healthy but unrelated server can fail independent assertions. Provider failures and invalid/truncated responses remain separate from policy rejection, startup failure, task assertion failure, infrastructure errors, and interrupted/not-run cases. Null results/assertions mean they were not measured. A completed, cleaned run exits 0 regardless of model score; an incomplete run or unresolved cleanup exits 1. There is no 100% quality threshold.

C09 retains the accepted password containing dollar signs, single/double quotes, backslashes, spaces, and `#`. The stock database image's initialization limitations can cause a model-authored configuration to fail this case. Prompt version 4 supplies a [tested MySQL bootstrap example](../mysql-bootstrap.md) for the model to include, with safe SQL encoding and authenticated readiness. The evaluator does not simplify the password or replace the output to obtain a passing result. The example's real Docker regressions verify C09 and extended multiline credentials without calling the model; they do not establish a model pass rate.

## Reports and recovery

Each run prints `/app/.runtime/evaluations/<runId>/`, bind-mounted to the repository's ignored `.runtime/evaluations/<runId>/`. Reports survive runner recreation and rebuilding. This directory contains:

- `terminal.log`: the same progress, individual assertion results, complete per-case result records, and final counts printed by the evaluator. Lines append during the run.
- `results.json`: atomically replaced checkpoints containing all ten cases, distinct failure/cleanup outcomes, timings, available usage, prompt/artifact digests, suite/prompt/evaluator versions, full policy/catalog and provider parameters, and aggregate counts/percentages.
- `Cxx.artifact.json`: only for policy-accepted cases; the original document, validated metadata, and value-free requirements. It is written before resource creation to support cleanup after a crash. It contains no private values or provider credentials. These artifacts are never a generation fallback.

The existing runner runs as root for daemon access. Its report directories are mode 0700 and files mode 0600, owned by root on Linux bind mounts. Read a structured report through the container without host pnpm or changing permissions:

```bash
docker compose --env-file .env -f infra/docker-compose.yml exec runner cat /app/.runtime/evaluations/<runId>/results.json
```

Identities and expected volume names are checkpointed before Start. Each accepted case enters cleanup even on startup/assertion/cancellation/reporting errors. Cleanup has a fresh three-minute budget, verifies ownership through the shared runtime driver, removes stopped containers and the private network, then verifies and deletes only that case's expected disposable volumes. Stop/Start within a case preserves its data. A cleanup failure stops further scheduling and keeps recovery identifiers; it never changes a model score into a cleanup score.

Keep the default attached terminal. Ctrl+C sends SIGINT to the evaluator, which cancels pending work and attempts cleanup with its independent three-minute budget. Do not restart or stop runner while evaluation is active: Docker may kill an exec process without delivering SIGTERM or waiting for its cleanup. A disconnected terminal or forced kill can also leave resources pending. Stop the original evaluator process and restore the same Docker daemon before explicitly retrying cleanup:

```bash
docker compose --env-file .env -f infra/docker-compose.yml exec runner node dist-evaluation/evaluation/cli.js --cleanup <runId>
```

Recovery requires neither the provider key nor saved private values. It reads bounded regular report/artifact files, rejects changed suite versions/identities/digests/policy, and revalidates the original artifact before runner cleanup. It processes pending/failed cleanup only, appends recovery outcomes to the transcript, and checkpoints them. It never generates, starts, or resumes unmeasured cases. A crash checkpoint still marked running becomes interrupted; the run remains incomplete. Recovery exits 0 when no pending cleanup remains, even if the original benchmark was incomplete. Keep the report/artifact files until all owned resources are absent; never use global prune to recover a run.

## Verification

`pnpm test:evaluation` runs 20 mocked-provider/runtime and driver-boundary checks without a database or inference. They cover the ten tasks, fixed denominator, failure classification, exact C09 bytes, no repair, same-artifact persistence restart, health observation, interruption, file checkpoints/transcript agreement, secret-free artifacts/reports, rejected recovery tampering, and ownership-checked disposable volume deletion.

`pnpm test:evaluation:runtime` passed on Engine 28.1.1 using all four pinned images. The frozen test-only fixture proved exact special-character messages/environment values, HTTP, cross-service HTTP, DNS/TCP, positive and negative database authentication, MySQL persistence over Stop/Start, negative readiness after stopping the database, and verified resource/volume cleanup. This verifies trusted probe execution, not model quality; the test fixture never enters the evaluator's provider path. The subsequent [live baseline](run-074b86dd.md) reached no generated workload starts.

The runner image built successfully with its normal worker command unchanged. All 20 deterministic checks and the four-image Docker smoke passed through `docker compose exec` in a disposable runner container. Help, missing-key classification, persistent report/transcript access, cleanup recovery and report retention across runner recreation passed. Production/development Compose boundary checks passed. Checks used explicit non-secret settings, an idle test control process and read-only fixture mounts; no application deployment or inference was performed. See [the verification record](../direct-compose-verification.md). The operator’s [live baseline](run-074b86dd.md) is recorded separately from these deterministic checks.
