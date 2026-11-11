# Verification and upgrade

Recorded source verification establishes the direct-Compose pipeline, not deployment of the application. Detailed historical counts and subsequent fixes are consolidated in [history](history.md).

## Evidence and limits

| Layer                            | Recorded evidence                                                                                                                                                 | What remains unproven                                        |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Contracts/provider/policy/UI/API | Integrated gate: 377 passes, one host-specific older-Engine skip; nine MySQL migrations applied/replayed; builds/type checks/lint passed                          | Real endpoint behavior and deployed browser flows            |
| Four-image lifecycle             | Engine 28.1.1 fixture smoke passed exact saved execution, value delivery, private connectivity/denial, terminals, rollback/cleanup and MySQL Stop/Start retention | Model compliance or live generation score                    |
| Evaluator probes                 | Trusted HTTP/DNS/TCP/authentication/negative-readiness/persistence probes and scoped volume cleanup passed                                                        | Correctness of every future generated workload               |
| Runner packaging                 | Container exec/help/preflight/report retention/recovery checks passed with normal image entry point preserved                                                     | Full database-backed application deployment                  |
| First live baseline              | [074b86dd](evaluation/run-074b86dd.md): all cases terminal, clean; policy/startup/task 0/10                                                                       | Successful model-authored startup/task execution in that run |
| Latest prompt references         | MySQL special-character bootstrap and MongoDB health-check Docker regressions passed                                                                              | Full benchmark at prompt v5/current endpoint                 |

Routine tests use mocked inference and explicit non-secret configuration. Agent Compose checks select `/dev/null` as the environment file; no protected file loading is permitted. No evidence here claims paid requests, credential provisioning, automatic conversion, deployment or broad Docker cleanup.

## Live evaluation

The current human-operator command runs the precompiled evaluator in the existing idle runner:

```bash
docker compose --env-file .env -f infra/docker-compose.yml exec runner node dist-evaluation/evaluation/cli.js
```

Use the running application's project/files (including the dev override when applicable), configured `OPENAI_BASE_URL`, `OPENAI_API_KEY` and `OPENAI_MODEL`, and a rebuilt/recreated runner. API remains socket-free. See [runner usage](evaluation/terminal-runner.md) for report retention, exit status and `--cleanup <runId>`. Preflight failures schedule no inference and cannot measure model quality.

## Legacy upgrade

The version 1 template generator/runtime has no compatibility or conversion branch. This checklist is for an operator upgrade; it is not a deployment already performed.

1. Block new work on the old installation. Using the previous version, drain generation/runtime jobs, stop legacy workloads/terminals, and verify cleanup and released reservations. The replacement cannot manage those deployments/jobs.
2. Back up database, artifact storage, workload volumes and the encryption key. Retain old records/files/volumes; no automatic deletion, conversion or global prune.
3. Deploy all nine committed MySQL migrations and replace API/web/runner together. Keep database/encryption/artifact settings consistent. Only runner gets the Docker socket; only API and runner evaluation receive inference settings.
4. Existing legacy configurations remain unsupported for Start/terminals. Create a new version 2 configuration with every required binding supplied, generate, review, then explicitly Start.
5. Verify generation errors, Start/Stop/status, observed services, terminal authorization/cleanup and preserved data on the target installation. Ordinary Delete preserves named volumes.

General editing/export, secret rotation, automatic product trials and explicit production-volume deletion remain deferred. Published workload ports remain rejected.
