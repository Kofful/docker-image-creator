# Generation and runtime workflow

Generation, explicit deployment and testing are separate workflows. [Architecture](architecture.md) describes components; the API references define request details.

## Generate and save

1. User selects 1–4 approved services, supplies required environment values/shared bindings and optional instructions.
2. API validates input, encrypts values and queues a durable job. The browser polls its ID.
3. API worker sends value-free requirements, exact server identities/catalog/policy and opaque references to the [LLM adapter](openai-compatible-adapter.md).
4. One model response is captured encrypted, then [strictly validated](compose-validation.md). Invalid content fails with no repair/fallback. Transient HTTP retries are bounded separately.
5. Accepted original bytes/digest/derived metadata become an immutable revision and private artifact. Status reports `runtimeValidation: not_performed`; generation makes no Docker calls.

[Configuration API](configuration-api.md) and [supplied values](supplied-environment.md) cover persistence, polling, confidentiality and limits.

## Deploy and interact

Explicit Start commits a durable operation after owner/revision/admission checks. Runner revalidates the saved document and independently stored bindings, then executes its original bytes with private supplied-value injection. It pulls approved images, waits up to 120 seconds for health, and leaves the deployment running. Runner is the only product process with Docker access.

One configuration per user holds a running reservation; pending, partial and unknown state retain it until all services are verified stopped. Operations serialize with idempotency, leases and fencing. API/runner restarts preserve workloads; service exit/host reboot require explicit Start. Failed Start attempts scoped rollback while retaining data.

Services communicate only within their configuration's internal isolated bridge. Host publication is rejected. [Connect](terminal-api.md) opens a ticket-authorized Docker exec shell through API/runner; no SSH or published port is involved. Stop preserves named volumes. Delete requires stopped resources, verifies cleanup before hiding the configuration, and retains production volumes/recovery records. See [runtime API](runtime-api.md) and [saved execution](saved-compose-runtime.md).

## Evaluate separately

The [ten-case terminal evaluator](evaluation/terminal-runner.md) shares provider/validator/driver code, creates disposable resources, uses independent behavior probes, and writes reports without database records. It runs only when explicitly invoked. [History](history.md) separates deterministic fixture success from live model results.

## Deferred behavior

Automatic temporary product validation is not implemented. Any future trial must use fresh attempt-owned resources, separate readiness/task checks and verified cleanup before success, without modifying a lasting deployment. Infrastructure failure must leave a revision unverified rather than declare it invalid. General editing/export, secret rotation and explicit production-volume deletion remain deferred.
