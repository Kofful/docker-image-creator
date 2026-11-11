# First live baseline: 074b86dd

Historical operator-supplied transcript, received 2026-11-06. The agent did not issue inference requests or inspect private runtime reports. This measures the earlier OpenRouter integration, not the current configured endpoint.

| Metadata                   | Value                                                              |
| -------------------------- | ------------------------------------------------------------------ |
| Run ID                     | `074b86dd-9efa-4f34-aa4e-d19ece17f768`                             |
| Directory                  | `/app/.runtime/evaluations/074b86dd-9efa-4f34-aa4e-d19ece17f768`   |
| Model                      | `google/gemma-4-26b-a4b-it:free`; zero provider price ceilings     |
| Mode                       | First response, no content repair/replacement                      |
| Evaluator / suite / prompt | 1 / 1 / 2                                                          |
| Suite digest               | `53efd0c46537ff001de3c3d8e41b852758a63a0f49b800b02a8e38d6c6be40bd` |
| Preflight                  | Docker/Compose/four-image checks passed                            |

| Cases        | Outcome                                   | Measured checks                        |
| ------------ | ----------------------------------------- | -------------------------------------- |
| C01–C08, C10 | `provider_failure: PROVIDER_RATE_LIMITED` | Policy/startup/task unmeasured         |
| C09          | `policy_rejected: UNKNOWN_FIELD`          | Policy failed; startup/task unmeasured |

Policy acceptance, healthy startup and task success were each **0/10 (0%)**. Nine cases received no usable completion; the only available completion failed policy. No generated workload started; all cleanup was `not_needed`. `complete: true` and `operationallySuccessful: true` mean all ten reached terminal outcomes without infrastructure/interruption/cleanup failure, not successful generation.

C09 generation took 19,887 ms with one reported HTTP attempt and 1,663 prompt / 913 completion / 2,576 total tokens. Provider failures took roughly 2.1–2.6 seconds each; exact HTTP attempts/usage/rate-limit source were unavailable. The transcript cannot distinguish provider quota from upstream capacity or identify the rejected field; no candidate/path was retained there. Do not infer total requests, guess the field, weaken policy or merge later results into this run.

Subsequent diagnostics, prompt changes and fixture regressions are summarized in [history](../history.md). The [current evaluator](terminal-runner.md) adds private redacted body traces; a fresh complete run is needed for the current endpoint/prompt score.
