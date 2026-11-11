# OpenAI-compatible LLM adapter

`OpenAICompatibleGenerationProvider` uses the pinned OpenAI JavaScript SDK for both API generation and explicitly invoked evaluation. Current deployment targets an operator-configured Modal-compatible Chat Completions endpoint/model. It supersedes the [historical OpenRouter adapter](openrouter-adapter.md); no default endpoint/model, alternate provider or pricing extension is used.

## Configuration

| Variable          | Required value                                                                                             |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| `OPENAI_BASE_URL` | HTTPS API base including `/v1`, e.g. `https://your-endpoint.modal.run/v1`; SDK appends `/chat/completions` |
| `OPENAI_API_KEY`  | Endpoint's bearer credential, according to its deployment's authentication contract                        |
| `OPENAI_MODEL`    | Exact served model identifier                                                                              |

The URL must exclude embedded credentials, query and fragment. Missing/invalid settings fail `PROVIDER_NOT_CONFIGURED` without an HTTP call; application startup does not invoke inference or require these settings. `OPENROUTER_API_KEY` is not consumed.

Compose passes settings only to API and runner evaluation. Web, application MySQL and Docker subprocesses/workloads never receive them. Application/evaluator code reads process variables without loading environment files. Operator configuration is documented in [.env.example](../.env.example); agent checks must not load private files. Rebuild/recreate API/runner with the usual project/files after changes, keeping runner idle; see [setup](local-setup.md).

## Request contract

The SDK calls nonstreaming Chat Completions with configured model and `max_completion_tokens: 16384`. Temperature is omitted. Prompt v5 requests raw complete YAML with exact identities/policy/catalog, selected services, instructions and named opaque bindings. Only allowlisted metadata is included; actual supplied values/request-local keys are excluded. Instructions/purposes remain model-visible.

MySQL requests include the [bootstrap reference](mysql-bootstrap.md) introduced in v4. MongoDB requests include an authenticated `mongosh` reference reading credentials from `process.env` and pinging against `admin`. Whole script arguments require YAML block scalars or complete quoting; internal shell/JavaScript quotes do not protect colon-space from YAML parsing. References are instructions for the model, never a compiler or post-generation rewrite. Prompt version is independent of revision/policy version 2.

Product generation and evaluation accept one content response. Invalid JSON, invalid Compose or policy rejection ends creation without feedback or replacement. Strict validation precedes persistence and execution, and accepted content remains byte-for-byte unchanged.

## Limits and metadata

| Control             | Behavior                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------- |
| Generation deadline | Five minutes shared with caller deadline/cancellation                                                          |
| HTTP retries        | SDK retries disabled; adapter allows at most three attempts for network/408/429/5xx failures                   |
| Backoff             | 500/1000 ms fallback; usable `Retry-After` honored up to 30 seconds; larger waits fail rather than retry early |
| Bodies              | Request log ≤1 MiB; response ≤8 MiB; extracted Compose ≤1 MiB                                                  |
| Rejections          | Invalid UTF-8/JSON/schema, tool calls, empty/truncated/incomplete content, reported-model mismatch, redirects  |
| Errors/logging      | Fixed safe public codes; SDK logging off; bounded [redacted bodies](llm-body-logging.md) stored privately      |

New results/jobs use `provider: openai` to identify the transport, not an OpenAI-hosted model. Safe metadata retains configured/reported model, timings, HTTP attempts and available integer token usage. Historical records retain their original provider/model. Evaluation omits key/endpoint URL from reports.

`pnpm test:compose-provider` uses the actual SDK with mocked HTTP for request routing/authentication, private-field exclusion, exact output, metadata, retries/limits/cancellation and one-response behavior. `pnpm test:evaluation` verifies orchestration/reporting. [History](history.md) records passes; mocks do not establish live endpoint availability or model quality.
