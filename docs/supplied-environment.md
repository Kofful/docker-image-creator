# Creation-time environment values

Step 2 is implemented as a gated foundation. The creation form, API validation, encrypted persistence, and shared bindings are present. Production activation waits for direct Compose generation and runner validation in steps 3–5. The current fake generator cannot consume these bindings and never claims version 2 jobs.

## Availability and input

Authenticated `GET /api/v1/config-input-options` returns `{ "suppliedEnvironment": false }` with `Cache-Control: no-store`. The form uses that capability to retain the current creation flow until integration is ready. Valid version 2 submissions currently return 503 without creating records. `GenerationSettings.suppliedEnvironmentEnabled` is an internal activation gate, overridden only in integration tests at this stage; it is not an operator environment variable. Do not enable it in production while the legacy worker is active.

The version 2 `POST /api/v1/configs` contract adds these fields to name, description, instructions, and selected services:

```json
{
  "inputVersion": 2,
  "environmentValues": [
    {
      "key": "database-password",
      "value": "disposable-example-only",
      "purpose": "Application database password"
    }
  ],
  "environmentBindings": [
    {
      "service": "db",
      "name": "MYSQL_PASSWORD",
      "valueKey": "database-password"
    },
    { "service": "api", "name": "DB_PASSWORD", "valueKey": "database-password" }
  ]
}
```

This fragment illustrates sharing; a MySQL request also requires a supplied `MYSQL_ROOT_PASSWORD` binding. MySQL requires both password bindings, MongoDB requires `MONGO_INITDB_ROOT_PASSWORD`, and application services have no implicit required variables. Database/user defaults remain public `app` settings; optional supplied username/database overrides must still pass the later Compose validator. Every declared binding needs an existing value and selected service before enqueue. The model cannot request missing values in a later form or invent passwords.

Request-local value keys match `[a-z][a-z0-9_-]{0,63}` and must be unique. Container names match `[A-Za-z_][A-Za-z0-9_]{0,127}` and are case-sensitive and unique per service. Every value needs a nonblank purpose of at most 500 characters and at least one binding. Limits are 64 supplied values, 128 total bindings, 32 bindings per service, 4,096 UTF-8 bytes per value, and 16,384 bytes of values per request. Both arrays are required in version 2, including empty arrays when no values are needed. Unversioned environment inputs are rejected with 400.

Values are never trimmed or interpolated during input/storage. Spaces, dollar signs, quotes, hash characters, backslashes, line breaks, and valid Unicode survive encryption/decryption exactly. Empty values, NUL, lone UTF-16 surrogates, and oversized values are rejected with value-free validation messages. NUL cannot be represented in a process environment. Docker interpolation and actual container round trips remain step 5 checks.

## Confidentiality and persistence

Migration `20261105000000_supplied_environment` adds `configurations.input_version`, defaulting existing records to 1, and the private `supplied_environment_values` / `service_environment_bindings` tables. It does not convert, delete, or rewrite existing configurations or secrets. Bindings use a composite foreign key that requires the value and binding to belong to the same configuration. Environment-name uniqueness uses an ASCII binary collation to preserve case distinctions.

Creation atomically saves the configuration, queued attempt, encrypted values, and binding rows under the existing user admission lock. Values use the existing AES-256-GCM `SecretBox` with authenticated context `<configId>:<reference>`. Each value gets a fresh opaque `DIC_SECRET_<32 lowercase hex>` reference, independent of its request-local key and container names. Several bindings share the same reference and ciphertext. A container variable named `PATH` or `DOCKER_HOST` therefore does not become the runner's interpolation key.

The queued encrypted generation input contains an explicit allowlist of `ComposeGenerationRequirements`: server-owned identity, service selections, instructions, purposes, opaque references, and assignments. It contains neither plaintext values nor the original value objects/keys. Supplied values appear only in their separate encrypted records. Ordinary configuration JSON, responses, previews, and generation status omit values, ciphertext, and binding rows. Instructions and purposes are model-visible; the form tells users to keep credentials out of those fields.

Version 2 idempotency uses a domain-separated HMAC-SHA256 fingerprint with the existing encryption key rather than an unkeyed password-bearing request hash. A replay returns the existing job and references; changing a value with the same key returns 409. The original version 1 fingerprint remains unchanged while that path is active. Ownership still comes from the authenticated configuration, never from submitted owner identifiers.

The Vue form masks values by default and offers explicit reveal/multiline editing. It stores no input in local/session storage, updates bindings when service names or value keys change, and clears its private state on navigation. Missing bindings and invalid values are reported before submission. There is no saved-value readback, editing, export, or rotation interface.

## Build and verification

Shared validation lives in `packages/contracts/src/environment.ts`, used by the API and Vue. Contracts now build CommonJS runtime JavaScript for Nest; the package's module entry points Vite at the TypeScript source. API/runner images copy the built package. API/web build and development commands build contracts first. Restart API development after changing shared runtime validation so its compiled copy is refreshed.

Relevant checks are `pnpm test:api`, `pnpm test:web`, `pnpm test:compose-contract`, `pnpm typecheck`, and the production web build. The API harness creates disposable MySQL 8.4.11, deploys all migrations twice, and supplies explicit random test configuration without loading environment files. Supplied-value checks cover completeness, unsupported input, ownership, encrypted persistence, exact special characters, shared bindings, idempotency, cross-configuration foreign-key rejection, value-free provider metadata/responses, the default gate, and legacy-worker exclusion. Frontend checks cover masking, shared references, required passwords, byte limits, multiline editing, renaming, and browser storage exclusion.

Verified on 2026-11-05: all eight migrations applied and replayed; 102 backend tests passed with one older-Engine check skipped on the supported host, all 107 frontend tests and nine contract tests passed, and workspace type checks/lint plus the production web build passed. The concurrency test now waits for durable slot release instead of assuming a fixed commit delay. API/runner Dockerfile copy changes were reviewed but application images were not rebuilt or deployed.

This slice makes no inference calls and does not activate supplied-value generation or prove generated Compose healthy. The [step 3 OpenRouter adapter](openrouter-adapter.md) is now implemented and tested with mocked HTTP; [step 4 validation and persistence](compose-validation.md) are also implemented behind a queue gate. Step 5 integrates execution before enabling the capability.
