# Direct Compose verification and operator handoff

Step 7 source verification and the operator cutoff documentation were completed on 2026-11-06. Steps 1–6 are implemented. The subsequent container-only requirement now uses the existing runner image; the earlier API-container Docker failure is addressed without changing the API's permissions. The operator subsequently supplied a [completed first live baseline](evaluation/run-074b86dd.md): nine rate-limited cases and one policy rejection, with task success 0/10 and no generated workload starts. The live-report prerequisite is satisfied without a minimum pass-rate gate; successful model-authored startup remains unverified. The agent accessed no protected environment file and made no inference request. No application deployment or legacy-data cleanup was performed by the agent.

## Verification commands

Use Node 22.23.4, pnpm 10.34.9 and the installed workspace dependencies. Routine tests mock the provider. The API harness creates its own MySQL 8.4.11 database and explicit non-secret test configuration; no command below loads a repository environment file.

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm build
pnpm test:runtime
pnpm test:evaluation:runtime
```

`pnpm test` includes contracts, mocked provider, policy, evaluator, frontend and API suites. Docker access is required for the API suite and the two opt-in runtime commands. They use disposable scoped resources and remove only their own test data. The lifecycle and evaluator smoke fixtures verify the execution/probe implementation; their results do not measure model quality.

Infrastructure Compose normalization was checked separately with explicit dummy process settings, `COMPOSE_DISABLE_ENV_FILE=1` and `--env-file /dev/null`. The original normalization kept the provider key only in API, the Docker socket only in runner, and host ports only in web. The runner integration now also supplies the provider key to runner for explicitly invoked evaluation. No application stack was started by this check.

## Results recorded on 2026-11-06

| Check                                              | Result                                                                              |
| -------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Compose contracts                                  | 9 passed                                                                            |
| Mocked OpenRouter provider                         | 29 passed                                                                           |
| Strict Compose policy                              | 88 passed                                                                           |
| Evaluator orchestration and driver boundaries      | 20 passed                                                                           |
| Vue frontend                                       | 108 passed                                                                          |
| API/MySQL/lifecycle/terminal integration           | 123 passed, one older-Engine rejection check skipped on Engine 28.1.1               |
| MySQL migrations                                   | All nine applied to disposable MySQL 8.4.11; replay found no pending migration      |
| Workspace TypeScript, ESLint and production builds | Passed                                                                              |
| Production and development infrastructure Compose  | Normalization and credential/socket/port boundary checks passed with dummy settings |

There are 377 passing routine checks and one host-specific skip. The initial `pnpm test` command completed all database-free/frontend suites but failed at the API harness's sandbox Docker boundary. `pnpm test:api` was then rerun with Docker access and passed. These results report the successful component checks without claiming that the original combined command exited successfully. Test containers and their disposable database data were removed by the API harness.

Both opt-in Docker commands passed on Engine 28.1.1. `pnpm test:runtime` verified all four images across two private projects, exact Compose execution, supplied/shared values, terminal authorization, private connectivity, outbound/host/cross-stack denial and MySQL persistence over Stop/Start. `pnpm test:evaluation:runtime` passed its four-image HTTP/DNS/TCP/environment/authentication/negative-readiness/persistence probe check. Both verified cleanup of their disposable resources and volumes.

Before container packaging, the actual evaluator Docker preflight reproduced `DOCKER_UNAVAILABLE` without daemon permission and passed with host daemon access, without inference. Product Dockerfiles confirm that the API image has neither the Docker CLI nor a socket mount; the runner is the privileged product service. Preflight errors now print targeted missing-key/host-Docker guidance and explicitly identify zero counts as unmeasured when no case ran. This changes reporting only, not scoring, suite inputs or model parameters.

After the reporting change, all 20 evaluator checks passed again with strict compilation and targeted lint. An explicitly empty-key CLI invocation exited 1 as expected, printed credential guidance and the unmeasured-score explanation, and scheduled no inference or Docker work. Changed-file formatting, whitespace checks and 133 local document links passed validation.

Two operator-supplied reports remain incomplete, with all ten cases not run and no resources created:

| Run ID                                 | Preflight failure         | Interpretation                                                               |
| -------------------------------------- | ------------------------- | ---------------------------------------------------------------------------- |
| `4fb71ebc-f0d4-49b4-851a-feafe27a9e98` | `PROVIDER_NOT_CONFIGURED` | Invoking process lacked a usable key; cleanup recovery found nothing pending |
| `ee316298-86ee-4169-be55-82d8ecb388b6` | `DOCKER_UNAVAILABLE`      | Credential check passed, but the `/app` invocation could not access Docker   |

Neither report measures model quality. They must not be published as a model failure rate or as a completed benchmark.

### Existing runner integration

The runner image built successfully using the frozen lockfile, normal application build and strict standalone evaluator compilation. The image retains its original worker command and working directory. No evaluation service or separate Dockerfile remains. Build inputs use concrete allowlisted source paths so Docker can skip private runtime directories; a real build reproduced the permission failure with wildcard re-inclusions and passed after their replacement. Protected files, test fixtures and generated artifacts remain excluded from the build context.

A disposable Compose project then invoked the precompiled evaluator with `docker compose exec runner`. Help, missing-key exit/classification, all ten not-run results, transcript/JSON access and cleanup-only recovery passed while the same runner container stayed running. All 20 evaluator/driver checks and the real four-image HTTP/DNS/authentication/negative-readiness/persistence/verified-cleanup smoke passed inside runner. Test fixtures were mounted read-only for verification only and are not shipped in the image. The control process was an idle Node process instead of the database-backed worker; this verifies exec/image integration without claiming an application deployment. Reports remained available after runner recreation.

Production and development Compose normalization/boundary checks passed with explicit dummy configuration: only runner has the Docker socket, only API/runner receive provider configuration, only web publishes ports, and runner has the report bind mount. Checks used `--env-file /dev/null`, an empty provider key for execution and no inference. The disposable test control-plane container/network/volume were removed, and workload cleanup verified absence of its resources/volumes. Targeted lint, formatting, whitespace and local documentation link checks passed. The later operator-supplied [live baseline](evaluation/run-074b86dd.md) records provider availability and policy outcomes; it did not reach generated workload execution.

## Live benchmark handoff

Run evaluation in the existing runner; no host Node or pnpm is needed. The runner image contains both the normal worker and the precompiled evaluator. Its default command is unchanged. Compose supplies the operator's configured key to API generation and runner evaluation, and binds the repository's `.runtime/evaluations/` into runner. API remains socket-free. Agents cannot read, source or load protected files and use `/dev/null` plus dummy settings for verification.

From the repository root, with the application already running, the human operator upgrades runner while no operations or terminals are active, then invokes the evaluator:

```bash
docker compose --env-file .env -f infra/docker-compose.yml up -d --build --no-deps runner
docker compose --env-file .env -f infra/docker-compose.yml exec runner node dist-evaluation/evaluation/cli.js
```

Use the same Compose project/files as the running application, adding the development override when applicable. `exec` uses the runner's existing environment, so recreate it after changing its key. The evaluator itself accesses no application database and creates no application records. It runs as a separate process in the same container and shares runner resources; invoke one benchmark at a time when idle. Reports survive runner recreation. See [container usage and report access](evaluation/terminal-runner.md). Do not paste the key into chat or a report.

Keep the printed run ID and `.runtime/evaluations/<runId>/` files. The command runs all ten fixed cases through exactly `google/gemma-4-26b-a4b-it:free`, without content repair or procedural replacement. Its three counts always have denominator ten. A completed, cleaned run exits 0 at any model score; an incomplete run or unresolved cleanup exits 1. Separate completed runs with provider-failure outcomes from preflight failures that schedule no inference. A frozen-fixture smoke does not measure model quality.

Review `results.json` for all ten case statuses, policy/healthy/task scores, timings, provider metadata, `complete`, `operationallySuccessful` and cleanup outcomes. Share only the evaluator's secret-free report path or results. Keep original report/artifact files until cleanup is verified. After stopping an interrupted evaluator and restoring its Docker daemon, retry pending cleanup with:

```bash
docker compose --env-file .env -f infra/docker-compose.yml exec runner node dist-evaluation/evaluation/cli.js --cleanup <runId>
```

Recovery makes no inference request and needs no saved private values. It does not resume unmeasured cases or turn an incomplete benchmark into a completed one. See [runner behavior and recovery](evaluation/terminal-runner.md) and the [ten fixed tasks](evaluation/compose-cases.md). C09 retains its special-character password even if stock-image initialization fails.

## Unsupported legacy cutoff

This is an operator checklist for a future upgrade, not a deployment performed by verification:

1. Prevent new requests to the old installation. Using its previous version, drain generation/runtime jobs and stop legacy workloads and interactive terminals. Verify stopped state, completed cleanup and released runtime reservations before replacing that version. The replacement cannot manage legacy deployments or recover their jobs.
2. Retain the application database, artifact storage, existing workload volumes and encryption configuration using the installation's backup procedure. Do not convert revisions, delete records or volumes, or use global Docker prune as part of this upgrade.
3. Apply all nine committed MySQL migrations and replace API, web and runner together. Supply `OPENAI_BASE_URL`, `OPENAI_API_KEY` and `OPENAI_MODEL` to API generation and runner evaluation; keep the Docker socket exclusive to runner. API and runner must share artifact storage, database configuration and the existing encryption key.
4. Existing configurations remain unsupported and cannot Start or obtain terminals. Create a new version 2 configuration with all environment values and shared assignments supplied before generation. Review the validated model-authored Compose before explicitly starting it. Stop and configuration deletion preserve its persistent data.
5. Check generation errors, explicit Start/Stop/status, terminal authorization and cleanup on the target installation. Deployment and browser end-to-end verification remain separate from source tests and the explicitly invoked benchmark.

General revision editing/history/export, secret rotation, automatic product validation trials and explicit production-volume deletion remain deferred. Published workload ports remain rejected; use private service DNS and authenticated container terminals.
