# Terminal Compose evaluation

Step 6 is implemented in `apps/api/evaluation`. This is an explicitly invoked test runner. It shares the OpenRouter adapter, strict Compose validator, and privileged Docker runtime driver, without booting Nest, connecting to MySQL, or creating application records. The production API does not gain Docker access. No live model benchmark has been run.

## Run

Use the repository's Node 22.23.4 and pnpm 10.34.9 installation, installed workspace dependencies, Linux Docker Engine 28+ with CPU/memory/PID enforcement, and Docker Compose v2.29.1 or newer within v2. The command uses the local Unix Docker socket, with the same trusted-host boundary as the product runner. No application stack, database URL, signing key, or encryption key is required.

The human operator must supply `OPENROUTER_API_KEY` in the command's process environment using their normal credential mechanism. No source command loads an environment file; agents must not inspect or load protected files. With that variable already exported, run from the repository root:

```bash
pnpm eval:compose --help
pnpm eval:compose
```

The command builds shared contracts and compiles the standalone runner, checks credentials are present, then checks Docker capabilities, Compose version, and availability of all four exact catalog image pins before inference. Missing credentials produce an incomplete file report without invoking Docker or the provider. Image pulls may use external registry connectivity; generated workloads remain on their internal isolated network and publish no ports.

It runs all ten cases sequentially. There is no case-selection option, repair, template substitution, alternate model, or paid fallback. The provider remains exactly `google/gemma-4-26b-a4b-it:free` with zero price ceilings and the product's bounded transport retries. Ten logical generation calls can therefore involve up to thirty HTTP attempts; successful responses report attempt counts and available usage. Failed requests may not provide usage/attempt metadata.

## Measurements

Each case has fresh user/configuration/revision UUIDs and in-memory disposable values. Only names, purposes, bindings, and opaque interpolation references reach the provider. The first response is policy-validated, then its original bytes and digest pass to the production driver. Pull time is separate from the driver's 120-second Compose startup wait. The evaluator checks running/healthy observations eleven times with ten one-second waits before independent assertions. Observation overhead is included in its reported duration.

Trusted probes test exact UTF-8 HTTP message bodies, DNS/TCP connections, MySQL application/root queries, failed authentication, MongoDB authenticated ping/failed authentication, and exact environment delivery/public database settings. C05/C06 additionally stop the verified database container and require `/ready` to stop returning success. C09 writes a marker, stops and starts the same artifact and volume without another provider call, then queries the marker. The [fixed suite](compose-cases.md) has executable inputs and assertions in `apps/api/evaluation/cases.ts`; it supplies no expected Compose to the model.

Probe programs are evaluator-owned, use fixed argument arrays, and return only a pass/fail sentinel. Private passwords and expected messages travel through stdin or remain in memory for comparison; they never enter command arguments or reports. The Docker child environment contains only fixed runner settings and, for Compose execution, declared opaque supplied-value keys. It never inherits the provider key. Raw provider bodies, Docker inspection, stderr, container logs, and probe output are not logged. Auth failure probes distinguish authentication rejection from a connection error.

The three scores always use ten as their denominator: policy acceptance, healthy startup, and task success. A healthy but unrelated server can fail independent assertions. Provider failures and invalid/truncated responses remain separate from policy rejection, startup failure, task assertion failure, infrastructure errors, and interrupted/not-run cases. Null results/assertions mean they were not measured. A completed, cleaned run exits 0 regardless of model score; an incomplete run or unresolved cleanup exits 1. There is no 100% quality threshold.

C09 retains the accepted password containing dollar signs, single/double quotes, backslashes, spaces, and `#`. The stock database image's initialization limitations can cause a model-authored configuration to fail this case. The evaluator does not simplify the password or replace the output to obtain a passing result.

## Reports and recovery

Each run prints its report directory under `.runtime/evaluations/<runId>/`. This ignored directory contains:

- `terminal.log`: the same progress, individual assertion results, complete per-case result records, and final counts printed by the evaluator. Lines append during the run.
- `results.json`: atomically replaced checkpoints containing all ten cases, distinct failure/cleanup outcomes, timings, available usage, prompt/artifact digests, suite/prompt/evaluator versions, full policy/catalog and provider parameters, and aggregate counts/percentages.
- `Cxx.artifact.json`: only for policy-accepted cases; the original document, validated metadata, and value-free requirements. It is written before resource creation to support cleanup after a crash. It contains no private values or provider credentials. These artifacts are never a generation fallback.

Directories are created with mode 0700 and files with mode 0600. Identities and expected volume names are checkpointed before Start. Each accepted case enters cleanup even on startup/assertion/cancellation/reporting errors. Cleanup has a fresh three-minute budget, verifies ownership through the shared runtime driver, removes stopped containers and the private network, then verifies and deletes only that case's expected disposable volumes. Stop/Start within a case preserves its data. A cleanup failure stops further scheduling and keeps recovery identifiers; it never changes a model score into a cleanup score.

SIGINT/SIGTERM cancel pending work and allow cleanup to finish. After a forced process kill or daemon outage, stop the original evaluator process and restore the same Docker daemon before explicitly retrying cleanup:

```bash
pnpm eval:compose --cleanup <runId>
```

Recovery requires neither the provider key nor saved private values. It reads bounded regular report/artifact files, rejects changed suite versions/identities/digests/policy, and revalidates the original artifact before runner cleanup. It processes pending/failed cleanup only, appends recovery outcomes to the transcript, and checkpoints them. It never generates, starts, or resumes unmeasured cases. A crash checkpoint still marked running becomes interrupted; the run remains incomplete. Recovery exits 0 when no pending cleanup remains, even if the original benchmark was incomplete. Keep the report/artifact files until all owned resources are absent; never use global prune to recover a run.

## Verification

`pnpm test:evaluation` runs 20 mocked-provider/runtime and driver-boundary checks without a database or inference. They cover the ten tasks, fixed denominator, failure classification, exact C09 bytes, no repair, same-artifact persistence restart, health observation, interruption, file checkpoints/transcript agreement, secret-free artifacts/reports, rejected recovery tampering, and ownership-checked disposable volume deletion.

`pnpm test:evaluation:runtime` passed on Engine 28.1.1 using all four pinned images. The frozen test-only fixture proved exact special-character messages/environment values, HTTP, cross-service HTTP, DNS/TCP, positive and negative database authentication, MySQL persistence over Stop/Start, negative readiness after stopping the database, and verified resource/volume cleanup. This verifies trusted probe execution, not model quality; the test fixture never enters the evaluator's provider path. The live ten-case benchmark is step 7 and remains unrun.
