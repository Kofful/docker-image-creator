# LLM Compose evaluation rules

The implemented evaluator is a testing-only terminal command with ten fixed [cases](evaluation/compose-cases.md). It shares the current provider/validator/driver, but boots no Nest application, connects to no application database, and creates no product records. It runs explicitly inside the existing runner; generation never launches trials automatically.

## Scores

| Measure                | Pass condition                                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Policy acceptance      | First response parses and satisfies the complete policy, requested services/settings and declared references                |
| Healthy startup        | Accepted artifact starts all services within the 120-second readiness wait, then all remain running/healthy for ten seconds |
| Task success (primary) | Healthy startup plus every evaluator-owned behavioral assertion passes                                                      |

Each count uses denominator **10**, with raw counts and percentages. Provider failures and not-run cases remain in the end-to-end denominator but are classified separately. Null checks mean unmeasured, not failed Compose. Ten examples do not establish statistical reliability. Model-authored health checks cannot replace independent task probes. Image-pull time is recorded separately from readiness.

One logical generation per case; score the first complete response. No content repair, candidate replacement, procedural fixture, alternate model or paid fallback. Bounded transient HTTP retries are transport attempts, not content repairs. Record actual endpoint model/parameters, suite/evaluator/prompt/policy/catalog versions, digests, timings, available token usage, failure stage and cleanup. Keep each run's inputs/metadata for comparison rather than merging different versions.

## Failures and cleanup

Distinguish provider errors, invalid/truncated output, policy rejection, startup failure, failed assertions, infrastructure failure, interruption and not-run cases. Rejected policy is never executed. A healthy unrelated server still fails its task. Preflight failure schedules no inference; zero counts then mean unmeasured scores.

Every accepted artifact gets fresh test-owned resource identities/private values and verified cleanup. Cleanup outcome is separate from quality; unresolved cleanup/infrastructure failure makes the run operationally unsuccessful/incomplete and stops scheduling. Product Stop/Delete preserve volumes; evaluator cleanup may delete only its verified disposable volumes.

A complete cleaned run exits 0 at any quality score, including 0/10. Incomplete runs/unresolved cleanup exit 1. There is no minimum model pass-rate gate.

## Reproducibility and evidence

[Runner instructions](evaluation/terminal-runner.md) define commands, file reports, body logs and cleanup-only recovery. Reports checkpoint all ten case outcomes, versions/digests, timing/usage, failures and aggregate scores. Disposable supplied values remain in memory and never reach prompts/reports/command arguments; opaque references and safe artifacts support recovery without values.

The [first live baseline](evaluation/run-074b86dd.md) completed at 0/10 with nine provider rate limits and one policy rejection. Subsequent fixture/prompt improvements and diagnostic evidence are recorded in [history](history.md); no full current-prompt score is documented. Deterministic hostile-YAML rejection tests are separate from these positive workload cases and their ten-case denominator.
