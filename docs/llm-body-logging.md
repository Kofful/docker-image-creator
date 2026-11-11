# LLM body logs

API generation and terminal evaluation capture redacted JSON HTTP request/response bodies, including retries, errors and policy-rejected output. Encrypted database input/output captures remain separate; evaluation adds no database records.

## Locations and access

| Flow       | Container path                                                            | Host persistence                   |
| ---------- | ------------------------------------------------------------------------- | ---------------------------------- |
| Creation   | `/app/.runtime/llm/<userId>/<configId>/<generationId>/`                   | `.runtime/llm/` bind mount         |
| Evaluation | `/app/.runtime/evaluations/<runId>/llm/<userId>/<configId>/<revisionId>/` | `.runtime/evaluations/` bind mount |

Generation uses its generation ID as the revision scope. Source defaults beside the artifact root; `LLM_LOG_ROOT` can override source/API logs. Evaluation always logs under its own report directory and records each attempted case's `llmLogDirectory`.

## Host directory setup

Before starting/recreating API, the human operator creates a private directory writable by API's Linux UID 1000:

```bash
mkdir -p -m 700 .runtime/llm
```

The bind uses `create_host_path: false` so Docker cannot silently create an unwritable root-owned path. A matching host UID can read files directly; other accounts require appropriate ownership/ACLs or elevated access. For an old installation with logs in the former `llm-logs` named volume, copy them while API is idle before recreation:

```bash
docker compose --env-file .env -f infra/docker-compose.yml cp api:/app/.runtime/llm/. .runtime/llm
docker compose --env-file .env -f infra/docker-compose.yml up -d --no-deps --force-recreate api
```

Skip copying if there are no old logs; include `--build` if the image predates logging and the dev override if applicable. Keep the former volume until copies are verified; mount changes do not migrate/delete it automatically. These are operator commands; agents must not load private environment files.

## Record format and retention

Each HTTP attempt pairs `<requestId>-<attempt>.request.json` and `.response.json`. New log version 2 includes scope IDs, timestamp, direction, attempt, body, byte count/completeness and response HTTP status when available; no repair flag. Existing v1 files stay unchanged. A failed transport has a null body/safe code; interruption may leave an unmatched request/partial capture. Missing provider configuration produces no HTTP/body file.

Files use 0600 under 0700 UUID directories; root/ancestor symlinks, unsafe IDs and overwrites are rejected. Evaluation binds are root-owned on Linux; read selected files through runner if needed. There is no public log API/UI. Logs survive recreation/configuration deletion/evaluator cleanup until the operator removes selected trace directories; no automatic retention sweep exists.

## Redaction and limits

Capture happens after request serialization and before response/schema/policy validation. JSON remains readable; non-JSON stays text. Invalid UTF-8 gets replacement characters only in the diagnostic copy and still fails provider parsing. These are diagnostic representations, not byte-exact replays or execution artifacts.

Headers, endpoint URLs and cookies are omitted. Known provider keys, credential fields/assignments, embedded JSON secrets, bearer tokens, URL user information, indented secret blocks and PEM private keys are masked. Token counts and opaque references remain. Structural redaction is bounded to 48 levels/100,000 values and never executes YAML. It may over-redact; unlabeled confidential prose cannot be reliably recognized. Keep actual values in dedicated masked fields, never instructions/purposes.

Request capture is limited to 1 MiB, response capture to 8 MiB, and Compose to 1 MiB. Oversized/partial capture is marked incomplete; oversized HTTP errors retain their failure classification. Filesystem/redaction failure produces `PROVIDER_LOG_FAILED`: creation fails; evaluation treats it as infrastructure failure and stops scheduling. Public errors omit bodies/paths/credentials. SDK logging/retries stay disabled; adapter retries remain bounded separately.

Mocked SDK/file/API/evaluator tests cover errors/rejections/retries, malformed/oversized bodies, secret exclusion, permissions/symlinks and explicit failure. Disposable containers verified host-visible UID-1000 writes and persistence. [History](history.md) holds results; these checks made no live model requests.
