# OpenAI-compatible Compose inference

The application uses the pinned `openai` JavaScript SDK behind `OpenAICompatibleGenerationProvider`. Both API generation and the explicitly invoked evaluator in the existing runner use this adapter. The operator selects a Modal OpenAI-compatible Chat Completions endpoint. This supersedes the original OpenRouter-only provider, fixed free Gemma slug and zero-price routing extension; no alternative provider or model is selected automatically. The [original benchmark](evaluation/run-074b86dd.md) remains an unchanged historical OpenRouter result.

## Configuration

Set these server-side variables through operator-managed deployment configuration:

```dotenv
OPENAI_BASE_URL=https://your-endpoint.modal.run/v1
OPENAI_API_KEY=<your-endpoint-bearer-token>
OPENAI_MODEL=<your-served-model-name>
```

The example URL is illustrative. Use the API base from your Modal deployment, including its `/v1` path; the SDK appends `/chat/completions`. Use the exact model identifier served by that endpoint. For Modal Endpoints with proxy authentication, the API key is the combined proxy token ID and secret, as described in [Modal's endpoint documentation](https://modal.com/docs/guide/endpoints). Custom deployed servers may use their own bearer token. Creating/deploying Modal resources or issuing live inference requests is outside this change.

All three variables are required when inference is invoked. The adapter accepts HTTPS URLs without embedded credentials, query strings or fragments. Missing/invalid settings return `PROVIDER_NOT_CONFIGURED` without an HTTP call, including before evaluator Docker preflight. Missing configuration does not block application startup. There is no default OpenAI endpoint, model, credential, or OpenRouter fallback. `OPENROUTER_API_KEY` is no longer consumed.

Compose passes these variables only to API generation and runner evaluation. Web, infrastructure MySQL, generated workloads and restricted Docker subprocess environments do not receive them. Application code and the evaluator read process variables only; they never load environment files. Agents must not read or edit protected environment files. Use the secret-free root `.env.example` to document settings.

After the human operator updates deployment configuration, rebuild/recreate API and runner using the existing application project/files:

```bash
docker compose --env-file .env -f infra/docker-compose.yml up -d --build --no-deps api runner
docker compose --env-file .env -f infra/docker-compose.yml exec runner node dist-evaluation/evaluation/cli.js
```

This assumes infrastructure is already running. Include the usual development override when applicable. Keep runner idle before recreating it. Evaluation stays inside the existing runner; no host pnpm is needed.

## Requests and validation

The adapter calls `client.chat.completions.create` with the configured model, `stream: false`, `max_completion_tokens: 16384`, and prompt version 4. It omits `temperature`, leaving sampling behavior to the selected model's default. The prompt explicitly identifies the generation task, requires raw YAML starting with the supplied project name, explains the Compose mappings and scalar types, and excludes prose, Markdown and follow-up questions. The readable JSON request carries only allowlisted requirements, label mappings and an explicit output contract. Requests containing MySQL also carry a [bootstrap reference](mysql-bootstrap.md), with Compose-escaped command arguments and an authenticated query health check. The model must include it in its document; the application never inserts or rewrites it after generation. The revision schema and execution policy remain version 2; prompt versioning is separate.

It sends standard Chat Completions fields only. OpenRouter-specific `provider.max_price` is removed. The model authors the complete Compose document. Actual supplied environment values remain excluded from requests, and strict YAML/policy validation still precedes persistence and execution. Product generation and evaluation both use one model response. Invalid JSON, invalid Compose or policy rejection ends the attempt without a replacement request. Prompt instructions guide the model; they do not guarantee valid output.

SDK retries are disabled (`maxRetries: 0`) so the adapter retains the existing maximum of three HTTP attempts per content response, the shared five-minute generation deadline, cancellation, 500/1000 ms fallback waits and `Retry-After` handling. A requested wait above 30 seconds still fails explicitly. Network errors and HTTP 408/429/5xx permit transient retry; permanent errors fail immediately. No content repair occurs for provider failures.

The adapter uses the SDK's raw response access to enforce its own 8 MiB JSON body and 1 MiB document limits before parsing. Invalid UTF-8/JSON, malformed choices, tool calls, empty content, incomplete finishes and a different reported model are rejected. Null tool metadata is accepted as absent. Completed content is returned byte-for-byte unchanged. Request/response bodies are now captured as [private redacted JSON files](llm-body-logging.md), including rejected output and HTTP errors. Non-success bodies are discarded before SDK error parsing after the bounded diagnostic capture; only status and retry timing determine retries. Redirects are rejected. SDK logging is explicitly disabled, and raw errors, credentials and response bodies are never attached to public errors.

Results and new generation jobs use `provider: "openai"` to identify the OpenAI-compatible transport, not an OpenAI-hosted model. The configured and reported model IDs, timing, attempts and available integer token usage are retained. Historical OpenRouter records retain their original provider/model on reads. Shared transport contracts now allow a model string rather than the former fixed Gemma literal. No database migration is needed. Evaluation records the configured model and standard generation parameters in terminal/file reports; it excludes the key and endpoint URL. Full redacted HTTP bodies are stored separately in the run’s `llm/` directory. Prompt, suite, policy, scoring, Docker isolation and cleanup behavior are unchanged.

## Verification

`pnpm test:compose-provider` exercises the actual SDK with mocked HTTP: configured routing/authentication/standard parameters, secret-free prompts, exact output, model/usage checks, missing/unsafe configuration, bounded error bodies, retries, deadline/cancellation and single-response failure behavior. `pnpm test:evaluation` covers orchestration, cleanup and configured-model reporting. Routine checks require no credentials or live inference. A successful test run does not establish availability or model quality at the operator's Modal endpoint.

Verification: 32 mocked SDK/provider checks, 21 evaluator/driver checks, 108 frontend checks and nine contract checks passed. The API suite passed 123 checks with one capability-test skip on a rerun without the concurrent image build; the first run hit two existing short-deadline tests under build load. Workspace type checks/lint and changed-file formatting passed. The runner image built with the frozen lockfile and passed help/missing-configuration CLI checks in disposable network-disabled containers. Production/development Compose configuration passed with explicit dummy settings and no environment-file loading. No live Modal request, credential configuration or application deployment was performed.

SDK behavior was checked against the official [OpenAI TypeScript SDK reference](https://developers.openai.com/api/reference/typescript). Modal URL, authentication and model-name behavior were checked against the [Modal endpoint guide](https://modal.com/docs/guide/endpoints).

Single-response verification: 41 mocked provider/body-log checks, 23 evaluator/driver checks and 88 policy checks passed. API integration passed 123 checks with one capability-test skip after updating the old two-capture expectation to one. Invalid YAML and policy rejection retain one encrypted response, publish no revision/artifact, and remain failed after later queue ticks. Transport retries remain bounded; no validation feedback or replacement prompt is sent. Workspace type checks/lint and standalone evaluator compilation passed. No live inference or application deployment was performed.
