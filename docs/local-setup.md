# Local setup

Use Linux Docker Engine 28+ with isolated bridges and CPU/memory/PID enforcement, and Docker Compose v2.29.1+ within v2. The runner image includes its Docker CLI/Compose binaries. Host Node/pnpm is required only for source development/checks. Run commands from the repository root with the same Compose project/file list throughout.

## Configure and start

A human operator creates private `.env` configuration from [.env.example](../.env.example), preserving existing settings on upgrades. Agents must not read, edit or implicitly load private environment files; agent checks use explicit non-secret process settings and `--env-file /dev/null`.

| Variable                                            | Setting                                                                                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `MYSQL_DATABASE`, `MYSQL_USER`                      | Default `docker_image_creator`; initialize the infrastructure database/account                                      |
| `MYSQL_PASSWORD`, `MYSQL_ROOT_PASSWORD`             | Distinct nonempty passwords; API/runner use only the application account                                            |
| `DATABASE_URL`                                      | `mysql://<encoded-user>:<encoded-password>@mysql:3306/<database>`; match initialization settings; no query/fragment |
| `AUTH_ACCESS_TOKEN_SECRET`                          | Private random signing key, at least 32 bytes                                                                       |
| `CONFIG_ENCRYPTION_KEY`                             | Separate 32-byte key encoded as 64 hex characters (`openssl rand -hex 32`); retain/back up with database            |
| `WEB_PORT`                                          | Compose default `8080`; example template sets `80`; loopback publication only                                       |
| `AUTH_TRUSTED_ORIGINS`                              | Exact comma-separated browser origins, including port, without trailing slash; match `WEB_PORT`                     |
| `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL` | HTTPS API base including `/v1`, endpoint bearer token, exact served model; required for generation/evaluation       |
| `CONFIG_ARTIFACT_ROOT`                              | Source default `.runtime/configs`; Docker fixes `/app/.runtime/configs` on shared named volume                      |
| `LLM_LOG_ROOT`                                      | Optional source override; Docker fixes `/app/.runtime/llm`, bound to host `.runtime/llm`                            |
| `TERMINAL_RUNNER_URL`                               | API relay target: `ws://runner:3001/terminal` in Docker; source override `ws://127.0.0.1:3001/terminal`             |
| `DEV_WATCH_POLLING`                                 | Default `false`; enable for Docker Desktop/WSL when filesystem events fail                                          |
| `API_PROXY_TARGET`                                  | Local Vite default `http://127.0.0.1:3000`; Docker dev sets `http://api:3000`                                       |

The API can start without inference settings; generation/evaluation then fails explicitly. There is no default endpoint/model. See [adapter details](openai-compatible-adapter.md). Generate signing/encryption keys separately; never reuse the example passwords for a deployment.

Prepare the log bind directory, writable by API UID 1000 on Linux, then start:

```bash
mkdir -p -m 700 .runtime/llm
docker compose --env-file .env -f infra/docker-compose.yml up --build -d --wait
```

Open <http://127.0.0.1> with the example's port 80, or <http://127.0.0.1:8080> with the Compose default. Set trusted origins accordingly. Register/login, create a configuration, supply required values, generate, review, then explicitly Start. Browser reload loses in-memory credentials and requires login again.

API startup deploys all nine committed Prisma migrations and connects to MySQL. MySQL health is an authenticated `SELECT 1`; API health is liveness only. With port 80:

```bash
curl --fail http://127.0.0.1/api/v1/health
docker compose --env-file .env -f infra/docker-compose.yml ps
```

Expected health response: `{"status":"ok","service":"api"}`. Only web is published. API, runner and MySQL use private service names. Only runner mounts the Docker socket. See the [network diagram](../README.md#docker-networking).

## Develop in Docker with automatic reload

```bash
docker compose --env-file .env -f infra/docker-compose.yml -f infra/docker-compose.dev.yml up --build -d --wait
docker compose --env-file .env -f infra/docker-compose.yml -f infra/docker-compose.dev.yml logs -f web api
```

The same browser port/origin and database volume are retained. Vite's internal port 5173 does not need adding to trusted origins in this mode. Vue hot-reloads; API restarts after successful TypeScript compilation. Invalid edits leave the last valid API running. Contracts build for API runtime; restart API after shared runtime-validation changes so its compiled copy is refreshed.

| Change                                     | Required action using the same Compose files                      |
| ------------------------------------------ | ----------------------------------------------------------------- |
| Vue/API source                             | Save; watcher reloads                                             |
| Dependencies, lockfile, Dockerfile         | `up --build -d --wait`                                            |
| Environment settings                       | `up -d --force-recreate` for affected services                    |
| Prisma schema/migrations or watcher script | `restart api`; startup regenerates client/deploys migrations      |
| Runner/runtime/prompt source               | `up --build -d --wait runner`; development does not reload runner |

The image holds dependencies. Selected source/configuration mounts exclude private environment files; Prisma generated files have their own volume. Native watching is default; set `DEV_WATCH_POLLING=true` and recreate if needed. To return to compiled containers, use the base file alone with `up --build` under the same project name.

## Stop and upgrade

Stop generated configurations through the app first when intended: shutting down application infrastructure leaves user workloads running. Then stop the control plane while preserving volumes:

```bash
docker compose --env-file .env -f infra/docker-compose.yml down
```

Include the dev override if that is how the application was started. Do not add volume-deletion flags. Existing MySQL volumes retain account credentials; changing initialization variables does not update those accounts. Keep the encryption key to retain decryptability.

For legacy template-generated installations, follow the [legacy upgrade checklist](direct-compose-verification.md#legacy-upgrade) before replacing API/web/runner. Rebuild runner when changing its source and recreate it after endpoint/model/key changes, with no operations/terminals/evaluation active. [Body-log setup](llm-body-logging.md#host-directory-setup) explains preserving logs from the former named volume.

## Source development and checks

Use Node 22.23.4 and pnpm 10.34.9 (pinned in `package.json`). Application/Prisma/Vite tooling does not load environment files. Supply explicit process variables and a reachable development MySQL server; Compose MySQL has no published host port. Export database/auth/encryption settings, inference settings when needed, and trust `http://127.0.0.1:5173` for local Vite.

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @docker-image-creator/api db:migrate
corepack pnpm build
```

Then run API, web and runner in separate terminals with consistent database/encryption/artifact settings:

```bash
corepack pnpm --filter @docker-image-creator/api dev
corepack pnpm --filter @docker-image-creator/web dev
corepack pnpm --filter @docker-image-creator/runner start
```

Set API's `TERMINAL_RUNNER_URL=ws://127.0.0.1:3001/terminal`. Runner needs the local Docker socket; API/web do not. Rebuild API before restarting the source runner after backend changes. Prisma uses `migrate deploy`, never schema push.

| Command                                                   | Purpose/prerequisites                                                                                |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `pnpm lint`, `pnpm typecheck`, `pnpm build`               | Static checks and workspace builds                                                                   |
| `pnpm format:check`                                       | Repository formatting; targeted docs check: `pnpm exec prettier --check README.md 'docs/**/*.md'`    |
| `pnpm --filter @docker-image-creator/api prisma:validate` | Prisma schema validation                                                                             |
| `pnpm test`                                               | Contract/provider/policy/evaluator/web/API suites; provider mocked, API uses disposable MySQL/Docker |
| `pnpm test:runtime`                                       | Opt-in four-image lifecycle/isolation/persistence smoke on supported Docker                          |
| `pnpm test:evaluation:runtime`                            | Real trusted probes plus database-reference regressions; no live inference                           |
| `pnpm test:dev`                                           | Disposable dev-stack HMR/reload/origin checks with temporary source copies                           |

Tests supply disposable non-secret configuration, replay committed MySQL migrations, and clean only owned resources. Never run checks that implicitly load protected files. No test substitutes SQLite. [History](history.md) and [verification](direct-compose-verification.md) record earlier outcomes; these instructions do not claim a fresh test run. For the explicit live benchmark, see [terminal evaluation](evaluation/terminal-runner.md).
