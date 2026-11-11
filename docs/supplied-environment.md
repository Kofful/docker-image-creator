# Supplied environment values

Version 2 creation requires users to supply all declared environment values before generation. Shared assignments are supported; server-generated passwords and post-generation input stages are absent. Authenticated `GET /api/v1/config-input-options` returns `{"suppliedEnvironment":true}`; capability failure blocks creation.

## Input and limits

Alongside configuration/service fields, `POST /configs` requires `inputVersion: 2`, `environmentValues` and `environmentBindings`, including empty arrays when appropriate:

```json
{
  "inputVersion": 2,
  "environmentValues": [
    {
      "key": "password",
      "value": "disposable-example",
      "purpose": "Application database password"
    }
  ],
  "environmentBindings": [
    { "service": "db", "name": "MYSQL_PASSWORD", "valueKey": "password" },
    { "service": "api", "name": "DB_PASSWORD", "valueKey": "password" }
  ]
}
```

This sharing fragment is not a complete MySQL request: `MYSQL_ROOT_PASSWORD` is also required. MongoDB requires `MONGO_INITDB_ROOT_PASSWORD`; application services have no implicit required values. Public database/user defaults are `app`; supplied overrides still undergo Compose validation. Every binding must name a selected service and existing value; every value must be used.

| Field/bound             | Rule                                                                         |
| ----------------------- | ---------------------------------------------------------------------------- |
| Value key               | Unique `[a-z][a-z0-9_-]{0,63}`                                               |
| Container variable name | `[A-Za-z_][A-Za-z0-9_]{0,127}`, case-sensitive, unique per service           |
| Purpose                 | Nonblank, at most 500 characters; model-visible                              |
| Counts                  | 64 values; 128 bindings total, 32 per service                                |
| Values                  | Nonempty, ≤4096 UTF-8 bytes each and ≤16,384 bytes per request               |
| Rejected content        | NUL, lone UTF-16 surrogates, oversized/invalid values; errors exclude values |

Values are never trimmed, pre-escaped or interpolated during input/storage. Valid Unicode, whitespace, dollars, quotes, hashes, backslashes and line breaks survive encryption exactly. Image initializer compatibility is separate from exact delivery; see [saved execution](saved-compose-runtime.md#network-and-image-constraints).

## Storage and confidentiality

`SuppliedEnvironmentValue` stores AES-256-GCM ciphertext with configuration/reference-bound authenticated context. `ServiceEnvironmentBinding` uses a composite foreign key to enforce the same configuration. Each value gets random `DIC_SECRET_<32 hex>` identity; several bindings may share its reference/ciphertext. Container `PATH`/`DOCKER_HOST` never becomes a runner process-setting key.

Creation stores configuration/job/values/bindings transactionally under admission locks. Queued encrypted generation requirements explicitly include only identities, services, instructions, purposes, opaque references and assignments; actual values/request-local keys are excluded. Configuration JSON/previews/status omit private values/ciphertext. Model-visible instructions/purposes must not contain credentials. Version 2 idempotency uses a domain-separated HMAC fingerprint rather than an unkeyed secret-bearing request hash.

Only Start decrypts into declared opaque keys in a restricted process environment. Values do not enter prompts, command arguments, public artifacts, logs or exports. Key rotation/readback/edit/export interfaces are deferred; retain the encryption key with database backups.

Vue masks values by default, supports explicit reveal/multiline entry, updates bindings on service/value renames, validates completeness and clears form state on navigation. Nothing is saved in browser storage. Shared rules live in `packages/contracts/src/environment.ts`; API uses its compiled CommonJS build and Vue uses the source. Restart API development after shared runtime-validation changes.

`pnpm test:api`, `pnpm test:web`, contract/static checks and real runtime value probes cover completeness, encryption, sharing, ownership, idempotency, foreign keys, exact values, private-field exclusion and UI handling. [History](history.md) records their outcomes.
