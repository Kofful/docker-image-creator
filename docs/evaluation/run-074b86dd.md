# First live evaluation baseline

The operator supplied this terminal report on 2026-11-06. It was run inside the existing runner container. This record summarizes the supplied transcript; the agent did not make provider requests or independently inspect the private runtime directory.

- Run ID: `074b86dd-9efa-4f34-aa4e-d19ece17f768`
- Report directory: `/app/.runtime/evaluations/074b86dd-9efa-4f34-aa4e-d19ece17f768`
- Model: `google/gemma-4-26b-a4b-it:free`, with zero provider price ceilings
- Mode: first response, no content repair or procedural replacement
- Evaluator/suite/prompt versions: 1 / 1 / 2
- Suite digest: `53efd0c46537ff001de3c3d8e41b852758a63a0f49b800b02a8e38d6c6be40bd`
- Docker/Compose/four-image preflight: passed

| Cases        | Outcome                                     | Policy/startup/task checks               |
| ------------ | ------------------------------------------- | ---------------------------------------- |
| C01–C08, C10 | `provider_failure`: `PROVIDER_RATE_LIMITED` | Not measured                             |
| C09          | `policy_rejected`: `UNKNOWN_FIELD`          | Policy failed; startup/task not measured |

The primary task score is **0/10 (0%)**. Policy acceptance and healthy startup counts are also 0/10. These are end-to-end counts with a fixed denominator: nine cases never received usable output. Only one completion was available for policy assessment, and it was rejected. No generated workload was started, and all ten cases recorded `cleanup: not_needed`.

C09 took 19,887 ms for generation and reported one HTTP attempt, 1,663 prompt tokens, 913 completion tokens and 2,576 total tokens. It reported the requested model. The nine provider failures each took roughly 2.1–2.6 seconds; their exact HTTP attempt counts and rate-limit sources were not retained. Do not infer total requests or usage from successful-response metadata alone.

The transcript ends with `complete: true`, `operationallySuccessful: true`, and no run-level failure. This means every case reached a terminal outcome without infrastructure/interruption/cleanup failure. It does not mean a generated configuration passed. This is a completed live baseline under the accepted evaluation rules, which have no minimum pass-rate gate. Successful model-authored startup and task execution remain unverified.

## Diagnostic limits and follow-up

The adapter currently allows at most three HTTP attempts per generation. When no `Retry-After` is provided, it waits 500 ms and then 1,000 ms between attempts. It respects a usable header up to 30 seconds and fails without retrying prematurely when the requested wait is longer. The report cannot distinguish a platform quota from upstream shared capacity. OpenRouter documents rate-limit metadata and retry headers in its [limits](https://openrouter.ai/docs/api_reference/limits) and [error handling](https://openrouter.ai/docs/api_reference/errors-and-debugging) documentation.

`UNKNOWN_FIELD` means a mapping contained a key outside the validator's allowed set. The report contains no field path or rejected candidate, so the exact key cannot be recovered from this transcript. Do not guess the field, weaken validation, or substitute a generated fixture.

Potential follow-up work is bounded rate-limit pacing/cooldowns and allowlisted diagnostic metadata, plus safe validation locations that do not echo arbitrary model-authored keys or values. No retry, prompt, model, policy, suite or scoring behavior was changed when recording this baseline. Preserve this report when evaluating any later version; do not overwrite or merge measurements from separate runs.
