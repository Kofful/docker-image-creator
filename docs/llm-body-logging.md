# LLM request and response body logs

LLM HTTP bodies are now logged for both config creation and terminal evaluation. The user selected readable JSON files with credentials and secret fields redacted. This supersedes the earlier metadata-only evaluation logging. Existing encrypted generation input/output captures remain unchanged; no schema migration or database-backed evaluation logging is added.

## Locations and access

| Flow            | Container directory                                                                 | Persistence                                           |
| --------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Config creation | `/app/.runtime/llm/<userId>/<configId>/<revisionId>/` in API                        | Host repository `.runtime/llm` bind mount             |
| Evaluation      | `/app/.runtime/evaluations/<runId>/llm/<userId>/<configId>/<revisionId>/` in runner | Existing repository `.runtime/evaluations` bind mount |

The revision ID used by generation is the generation ID returned when the configuration is created. Source development defaults to a `llm` directory beside the configured artifact root (`.runtime/llm` normally). `LLM_LOG_ROOT` optionally overrides the source/API body-log directory. Evaluation always uses its own report directory, independently of that variable. The CLI prints this directory, and every attempted case has a relative `llmLogDirectory` in `results.json` and its terminal result.

## Host directory setup

API body files now appear live under `<repository>/.runtime/llm/`; evaluation files already appear under `<repository>/.runtime/evaluations/<runId>/llm/`. The bind mount exposes the same files on both sides; no copying service or host Node/pnpm is needed. Both directories stay excluded from Git and Docker build contexts.

From the repository root, create the private API log directory before starting/recreating API:

```bash
mkdir -p -m 700 .runtime/llm
docker compose --env-file .env -f infra/docker-compose.yml up -d --no-deps --force-recreate api
```

Use your usual project name and add `-f infra/docker-compose.dev.yml` for a development deployment. If your API image predates body logging, include `--build`. The bind has `create_host_path: false`: it intentionally fails when the host directory is missing, rather than letting Docker create an unwritable root-owned directory. On Linux the API runs as `node` (UID 1000), so the host directory must be writable by that UID. A matching host UID can read the mode 0600 files directly; other accounts need appropriate ownership/ACL configuration or elevated access.

If the old API container already has logs in the former `llm-logs` named volume, copy those logs while it is idle **before** recreating it:

```bash
mkdir -p -m 700 .runtime/llm
docker compose --env-file .env -f infra/docker-compose.yml cp api:/app/.runtime/llm/. .runtime/llm
```

Then recreate API with the first command block. Omit the copy when there are no prior logs. Changing the mount does not copy historical logs automatically and does not remove the existing named volume. Keep that volume until you have checked the copied files. The evaluation bind mount is unchanged.

## Records

Each HTTP attempt writes two files, paired by a server-generated request ID and attempt number:

```text
<requestId>-1.request.json
<requestId>-1.response.json
```

Each generation call gets one request ID and accepts at most one content response. Invalid content ends the attempt without a replacement call. HTTP retries increment the attempt number within that request. New records use log version 2 and include ownership IDs, timestamp, direction, attempt, body, byte count and capture completeness. The repair flag has been removed. Existing version 1 files are preserved unchanged. Responses also include their HTTP status when available. A network failure has a null response body and a safe failure code. No response body exists if the endpoint never returned one. Cancellation or process termination can leave an unmatched request; any captured partial body is marked incomplete. Missing provider configuration makes no HTTP attempt and creates no body files.

Read new files directly from the host’s `.runtime/llm/` and `.runtime/evaluations/` trees, or inspect a chosen file through the corresponding container:

```bash
docker compose --env-file .env -f infra/docker-compose.yml exec api ls -R /app/.runtime/llm
docker compose --env-file .env -f infra/docker-compose.yml exec api cat /app/.runtime/llm/<userId>/<configId>/<revisionId>/<requestId>-1.response.json
docker compose --env-file .env -f infra/docker-compose.yml exec runner cat /app/.runtime/evaluations/<runId>/llm/<userId>/<configId>/<revisionId>/<requestId>-1.request.json
```

These are human-operator commands using the usual project and development override, if applicable. Agents do not load protected environment files. There is no public body-log API or UI. Body files are not printed in general application logs or evaluation summaries. They are retained across container recreation and configuration deletion until the operator removes the selected host trace directories; no automatic retention sweep is introduced. Evaluation workload cleanup leaves its reports and traces intact. Never use global Docker prune to remove logs.

## Content and redaction

Requests are captured at the SDK transport boundary after serialization, including the full messages and generation parameters. Responses are captured before SDK error parsing, JSON/schema checks or Compose policy validation. This includes HTTP error bodies, malformed JSON/text, truncated completions, model mismatches, rejected Compose, transient HTTP retries. Invalid content does not trigger another generation call. No procedural Compose generation is introduced. Runtime continues to use the original unmodified accepted model output, independently of its redacted diagnostic copy.

Authorization headers, cookies, endpoint URLs and other HTTP headers are excluded entirely. Supplied environment values are never sent to the model and therefore never included in the captured request. Redaction removes the configured API key in literal, JSON-escaped and URL-encoded forms; credential fields in JSON, including embedded JSON prompt strings; password/token/secret/API-key assignments in YAML and code strings; indented secret blocks; bearer credentials; URL user information; and PEM private-key blocks. Opaque required-value references remain visible. Standard numeric token-count fields are retained.

Valid JSON bodies are stored as readable objects; other response bodies remain strings. Invalid UTF-8 bytes use replacement characters in the diagnostic copy and still fail strict provider parsing. The log is a redacted diagnostic representation, not a byte-exact HTTP replay. Redaction uses bounded structural traversal (48 levels, 100,000 visited values) and lexical rules rather than executing or resolving model-authored YAML. It deliberately over-redacts some lines. Unlabelled confidential prose cannot be reliably recognized by field-based redaction; continue using dedicated masked environment fields rather than putting credentials in instructions or purposes.

Request bodies are limited to 1 MiB; response capture retains at most 8 MiB. Oversized responses are marked truncated/incomplete and fail the existing output limit; oversized HTTP error bodies retain their original HTTP failure classification. The generated Compose document itself remains limited to 1 MiB. Directories use mode 0700, files mode 0600, and paths use server-generated UUIDs. Symlink roots/ancestors, unsafe scope IDs and replacing existing records are rejected.

A filesystem/redaction failure becomes `PROVIDER_LOG_FAILED`; config generation fails explicitly instead of silently omitting the trace. Evaluation treats this as an infrastructure failure and stops scheduling cases. SDK logging remains off, SDK retries remain disabled, and the existing shared deadline and three-attempt limit still apply. Public errors never include body text, filesystem exceptions or credentials.

## Verification

Mocked SDK/file tests cover original requests, HTTP errors, rejected completions, transport retries, malformed and oversized bodies, transport failures, redaction, large-text handling, permissions, symlink/traversal rejection and explicit logging failures. Evaluator integration uses the real SDK adapter with mocked HTTP to retain all ten policy-rejected responses beside file reports; no workloads are started. API integration exercises authenticated config creation through the adapter with mocked HTTP and verifies private scoped files and secret exclusion. No live inference is required for these checks.

Verified for this milestone: 41 mocked SDK/provider/file-log checks and 23 evaluator/driver checks passed. The API suite passed 124 checks with one capability-test skip, including authenticated creation through the mocked SDK adapter and scoped redacted body files. Workspace type checks and lint passed. API and runner images built with the frozen lockfile; network-disabled disposable-container checks verified capture, redaction, private permissions and persistence across recreation, including API’s normal non-root user. Production/development Compose mounts and credential/Docker boundaries passed with dummy settings. Owned test volumes were removed. No live inference, credential configuration or application deployment was performed.

Host-bind verification passed: production/development Compose both resolve API logs to repository `.runtime/llm/` without automatic host-path creation; the evaluation bind and socket boundaries are unchanged. A disposable network-disabled API container, using its normal UID 1000 and the existing body-log image, wrote a redacted mode 0600 JSON file that was directly readable on the host after container removal. Test data was removed. The real host log directory was prepared with mode 0700; no application containers were restarted and no inference or protected environment files were used.
