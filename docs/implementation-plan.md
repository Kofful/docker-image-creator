# Implementation plan

Milestone 1 is in progress. Vue/Nest source, shared health-response types, pnpm workspace manifests, strict TypeScript configuration, formatting/type-check scripts, and three-service Compose infrastructure are present. Milestones 2–7 remain pending.

Scaffold checks completed: Compose configuration validation with explicit dummy credentials and no environment-file loading; JSON parsing and whitespace validation; shared-contract type checking and five TypeScript transpilation syntax checks using a cached compiler. Not yet complete: workspace dependency installation, a resolved committed pnpm lockfile, formatting/full application type checks/builds, runner scaffolding, container boot, and MySQL readiness. Registry DNS and Docker daemon access are unavailable in the implementation environment. See [local setup](local-setup.md) for exact commands and remaining gates. No application persistence or Prisma schema has been added.

| Milestone | Deliverables | Completion gate |
| --- | --- | --- |
| 1. Scaffold | pnpm workspace; Nest API/runner; Vue/Vite web; contracts; pinned versions; formatting/type checking; infrastructure MySQL; environment examples | Clean install, builds/type checks, web/API boot, MySQL readiness; document exact commands |
| 2. Persistence and auth | Prisma migrations, users, MySQL sessions, register/login/me/logout, guards, CSRF/origin protection, auth pages | Real MySQL integration tests; password hashing, duplicate email race, revoked sessions, cross-origin rejection |
| 3. Catalog and revisions | Node/Python/MySQL/Mongo templates, strict spec schema, policy compiler, config ownership CRUD, masked preview and export | Valid templates pass Compose validation; adversarial specs rejected; cross-user reads/writes denied |
| 4. Generation | Provider adapter, deterministic fake, bounded agent loop, catalog/validator tools, generation UI/status, encrypted secret references | Valid proposals render/save; malformed, unsafe, timed-out, and injected outputs fail safely; real provider smoke test only after credential setup |
| 5. Execution | Durable MySQL operations/leases, private runner, project naming/labels, start/stop, limits, reconciliation and redacted logs | Disposable Docker integration: multi-service network, readiness, failure recovery, simultaneous starts, port collision, data preserved across stop/start |
| 6. Console | xterm.js view, authenticated tickets/gateway, runner Docker exec stream, resize/disconnect, quotas and cleanup | Real shell input/output and resize; cross-user/session failures; logout/expiry closes transport; shellless image handled |
| 7. Completion | End-to-end UI flows, user-facing errors, scoped deletion, operational docs, CI and local setup | Register → generate → review/save → start → connect → stop → restart; separate confirmed volume deletion affects only target stack |

## Test strategy
Use focused unit tests for compiler/policy/state transitions; API integration tests against disposable MySQL for transactions and ownership; frontend component tests for meaningful validation/error behavior; Playwright for core browser flows; and opt-in integration tests against an explicitly designated Docker daemon. Avoid paid model calls in CI. Use a fake for deterministic coverage and a manual real-provider smoke test before declaring generation integration complete.

Docker tests must use unique project labels, bounded resources, and scoped cleanup. Never run destructive checks against unrelated containers or volumes. Do not replace failed real database/Docker verification with mocks and claim integration success.

## Done criteria
The application matches the MVP acceptance criteria, migrations work on a fresh MySQL instance, normal checks pass, environment/setup instructions reproduce a clean start, secrets stay out of generated public artifacts, and the documented deployment boundary is respected. List skipped checks and missing prerequisites explicitly. Do not mark milestones complete based only on generated source files.

## Operational documentation to add with implementation
Add actual setup commands, supported versions, API schema, environment reference, runner provisioning, encryption-key backup/rotation, database backup/restore, operation recovery, image catalog maintenance, and resource/data cleanup instructions once they can be verified. Keep application infrastructure Compose files separate from generated user stacks.
