# Project instructions

## Scope and source of truth
Build Docker Image Creator: a NestJS + Vue application with MySQL persistence, email/password accounts, LLM-assisted Compose generation, stack lifecycle controls, and an interactive container console. Read `docs/README.md` and the relevant design documents before implementation. These documents describe planned behavior, not existing capabilities. Keep them aligned with implemented behavior and record architectural changes in `docs/architecture.md`.

## Working conventions
- Implement one verifiable milestone from `docs/implementation-plan.md` at a time. Do not silently expand scope.
- Use TypeScript with strict checking throughout. Use NestJS modules, dependency injection, DTO validation, and thin controllers; Vue 3 Composition API with `<script setup lang="ts">`.
- Planned workspace: `apps/api`, `apps/web`, `apps/runner`, `packages/contracts`, `infra`, `docs`. Use pnpm workspaces; resolve supported versions and commit a lockfile during scaffolding. No package scripts or applications exist yet.
- Use Prisma migrations against MySQL. Never substitute SQLite for database integration checks or use schema push against shared databases.
- Share transport schemas and types through `packages/contracts`; never import backend implementation or ORM models into the frontend.
- Keep provider-specific LLM code behind an adapter. Mock provider calls in routine tests. Do not configure credentials, make paid calls, or change providers without the user's authorization and applicable credential setup workflow.
- Read existing files and check git status before edits. Preserve unrelated changes, including IDE and Codex configuration. Never commit secrets or generated runtime artifacts.
- Prefer small, clear changes. Document environment variables in a secret-free `.env.example`. Do not claim a check passed unless it ran; explain unavailable prerequisites.

## Environment file access
- Agents must not read, inspect, search contents, modify, source, or load files named `.env`, matching `*.env`, or matching `.env.*` anywhere in the repository. This includes access through tools, scripts, symlinks, and commands that implicitly load environment files.
- Exclude these files from repository content searches and bulk reads. Use secret-free `.env.example` and `.env.*.example` templates for environment documentation; only these example templates are exempt from the access restriction.
- Run checks with explicit non-secret test configuration that does not load protected files. If a task requires access to a protected file, explain the dependency and ask the user to provide a secret-free alternative.

## Product rules
- Authentication means registration, login, current user, and logout using email/password. No email transport, verification, reset emails, OAuth, or MFA in the MVP.
- All configs, revisions, operations, logs, terminal sessions, and Docker resources belong to a user and stack. Scope every lookup and action, including WebSocket messages.
- Generation saves a reviewable, validated revision. It never starts containers automatically. Starting a stack is a separate explicit user action.
- MVP image catalog: Node.js, Python, MySQL, MongoDB. Use explicit, tested tags and template-specific settings. Do not assume every image contains Bash or development tools.
- Every stack has one private, project-scoped bridge network shared by its services. Separate stacks must not share this network or the application's database network.
- The application's MySQL database is infrastructure, distinct from MySQL containers generated for users.
- A connection means an authenticated interactive Docker exec terminal. It is not SSH or automatic publication of every service port.

## Execution boundaries
- Treat prompts, LLM output, Compose YAML, environment values, and terminal input as untrusted.
- LLM tools can read the image catalog and validate candidate specifications only. They cannot invoke Docker, a shell, the filesystem, or the database directly.
- Only the runner may access the Docker daemon. Never expose the daemon socket/API to browsers or generated containers. Docker access is privileged; application checks do not constitute a hostile multi-tenant sandbox.
- Compile an allowlisted structured spec into Compose. Validate before persistence and again before execution. Reject unknown fields, privileged mode, host namespaces/networking, arbitrary bind mounts/devices, Docker socket mounts, external networks, and arbitrary build contexts.
- Never concatenate user text into shell commands. Spawn the fixed Compose executable with argument arrays and a restricted environment; use Docker exec APIs for terminal sessions.
- Scope resource names, labels, working paths, and operations with server-generated IDs. Verify ownership and labels before exec, stop, cleanup, or deletion. Never use global Docker prune.
- Preserve named volumes on stop. Require explicit confirmation and a separate action for deleting persistent data.
- Never log passwords, session tokens, API keys, generated secrets, or terminal keystrokes. Keep secrets out of LLM requests, persisted public specs, and exports; use encrypted secret storage and masked references.
- Enforce operation deadlines, resource quotas, concurrency limits, terminal idle/session limits, and bounded logs/output. Define actual defaults during implementation and test them.

## Validation expectations
Run relevant formatting, lint, type checks, and meaningful unit/integration/end-to-end tests as scripts become available. Critical checks cover authentication and session revocation, ownership isolation, malformed/adversarial LLM output, policy rejection, lifecycle reconciliation, concurrent starts, and terminal authorization/cleanup. Real Docker tests must use disposable project-scoped resources, never unrelated host containers. Keep acceptance criteria in `docs/implementation-plan.md` current.

## Skills
See `docs/skills.md` for available skill recommendations and their triggers. Skills are coding guidance, not runtime dependencies. Do not install unrelated plugins, change hosting providers, or replace the requested NestJS/Vue/MySQL architecture.
