# Terminal evaluation runner

The standalone evaluator in `apps/api/evaluation` shares the configured [LLM adapter](../openai-compatible-adapter.md), validator and privileged runtime driver. It creates no application database records. It is compiled into the existing runner image and invoked as a separate process; the normal worker command is unchanged and no evaluation service/image is required.

## Run in the existing runner

Requires an already running application, Linux Engine 28+ with resource enforcement, supported Compose v2, and operator-managed `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`. Keep runner idle and run one benchmark at a time: evaluation shares its container/daemon resources.

From the repository root, the human operator rebuilds/recreates runner if needed, then invokes it:

```bash
docker compose --env-file .env -f infra/docker-compose.yml up -d --build --no-deps runner
docker compose --env-file .env -f infra/docker-compose.yml exec runner node dist-evaluation/evaluation/cli.js
```

Use the same project/files as the running application; add the dev override when applicable. Recreate after endpoint/model/key/mount changes, since exec uses the container's existing environment. No host Node/pnpm is required. From runner's `/app/apps/api` directory, `node dist-evaluation/evaluation/cli.js` is equivalent; append `--help` for usage. `pnpm eval:compose` is the source-development entry point.

The CLI loads process variables only. These operator commands may select private `.env`; agents must use explicit non-secret settings and `/dev/null` instead. Provider settings are available only to API generation and the explicitly invoked runner evaluator; Docker subprocesses/workloads never inherit them. API remains socket-free.

Preflight checks inference configuration, Docker/Compose capabilities/resource enforcement and all four exact catalog images before inference. Missing configuration (`PROVIDER_NOT_CONFIGURED`) or daemon access (`DOCKER_UNAVAILABLE`) leaves all cases not run; zero counts are unmeasured. Preflight-only runs cannot measure model quality.

## Execution and measurements

Run all ten [cases](compose-cases.md) sequentially. There is no case-selection option, content repair, output replacement or model fallback. One logical request per case can involve up to three HTTP attempts; report available attempts/usage. Current parameters/model come from the configured adapter, not the historical OpenRouter model pin.

Each case gets fresh UUID identities and disposable in-memory values. The first response is validated; accepted original YAML/digest goes unchanged to the production driver. Pull time is separate from 120-second Compose readiness. Eleven observations separated by ten one-second waits establish the subsequent healthy period. Timing includes observation overhead.

Trusted probes check exact UTF-8 HTTP responses, service DNS/TCP, database authentication/query and wrong-password rejection, public settings and exact value delivery. C05/C06 stop the database and require readiness to fail. C09 inserts a row and restarts the same artifact/volume without generation to verify retention. Database probes distinguish authentication denial from connection failure. Passwords/expected private values stay in memory or stdin; fixed probe arguments and pass/fail sentinels avoid logging them.

Reports distinguish policy, healthy-start and task counts, each out of ten, plus provider/content/policy/runtime/assertion/infrastructure/interruption failures and cleanup. A complete clean run exits 0 regardless of model score; incomplete/unresolved cleanup exits 1. See [scoring rules](../llm-compose-evaluation.md).

C09 retains the accepted special-character password. Prompt v4 adds a [MySQL bootstrap reference](../mysql-bootstrap.md); v5 adds MongoDB health-check/YAML quoting guidance. These guide model output without patching it or simplifying test values. New runs must report their actual prompt version; fixture success is not model success.

## Reports and recovery

Runner writes `/app/.runtime/evaluations/<runId>/`, bound to host `.runtime/evaluations/<runId>/` and retained across recreation:

| File/directory                          | Contents                                                                                                                    |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `terminal.log`                          | Appended progress, per-assertion/case records and totals matching terminal output                                           |
| `results.json`                          | Atomic checkpoints for all ten cases, metadata/versions/digests, timing/usage, failure and cleanup outcomes, totals         |
| `Cxx.artifact.json`                     | Policy-accepted original document/validated metadata/value-free requirements, written before resource creation for recovery |
| `llm/<userId>/<configId>/<revisionId>/` | Redacted HTTP attempts including errors/rejected content; each case records `llmLogDirectory`                               |

Directories/files use 0700/0600. Linux runner writes as root; inspect a report through runner without relaxing permissions:

```bash
RUN_ID=replace-with-recorded-run-uuid
docker compose --env-file .env -f infra/docker-compose.yml exec runner cat "/app/.runtime/evaluations/$RUN_ID/results.json"
```

Resource identities/expected volumes are checkpointed before Start. Every accepted case enters cleanup, even after startup/probe/report/cancellation failure. Cleanup has a fresh three-minute budget, verifies labels through the shared driver, removes stopped containers/network, then verifies/deletes only expected disposable volumes. Failure halts further cases and retains recovery IDs/artifacts. Reports/traces remain.

Keep evaluation attached. Ctrl+C cancels work and attempts cleanup; restarting runner, disconnecting or forced termination can kill the exec process before cleanup. Stop the original evaluator and restore the same daemon before recovery:

```bash
RUN_ID=replace-with-recorded-run-uuid
docker compose --env-file .env -f infra/docker-compose.yml exec runner node dist-evaluation/evaluation/cli.js --cleanup "$RUN_ID"
```

Recovery needs no inference settings/private values. It reads bounded regular report/artifact files, validates versions/identities/digests/policy and cleans only pending/failed resources. It never generates, starts or resumes cases. Interrupted runs remain incomplete; recovery exits 0 when no cleanup remains. Keep artifacts until resources are verified absent; never use global prune.

## Verification

`pnpm test:evaluation` covers scoring/classification, all tasks, one-response behavior, checkpoints/transcript, interruption, secret exclusion and recovery tampering/ownership. `pnpm test:evaluation:runtime` checks real four-image probes, negative readiness, authentication, persistence and verified cleanup, plus database-reference regressions. Runner image/exec/report-retention checks passed. [History](../history.md) records outcomes and limits separately from [live baseline](run-074b86dd.md) scoring and deployment verification.
