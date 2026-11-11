# MySQL special-character credentials

The C09 reproduction with `mysql:8.4.11` failed `START_FAILED`/SQL error 1064 during application-user creation: stock initialization embedded a password inside SQL. YAML/shell quoting and pre-escaping environment values do not solve that boundary.

Prompt v4 introduced `mysqlBootstrap`, included only for MySQL requests and retained in current prompt v5. `apps/api/src/configs/mysql-bootstrap.example.ts` supplies command/health-check arrays for the model to copy with YAML block scalars or whole-argument quoting. Dollars are already Compose-escaped. This is model reference data; validation/runtime never inserts or repairs it.

## Reference behavior

- Reuse pinned-image Bash/gosu/entrypoint helpers, preparing owned directories before privilege drop and installing overrides as the mysql user.
- Preserve stock fresh/existing-data checks, temporary/final server lifecycle and timezone initialization. Existing volumes skip initialization.
- Keep raw environment passwords unchanged. Encode temporary SQL literals using doubled quotes under `NO_BACKSLASH_ESCAPES`, with binary-mode UTF-8 client handling for backslashes/line endings; quote database identifiers separately.
- Create requested database/application grants and local/configured remote root credentials. Authenticate through environment values rather than command arguments/options files; suppress SQL stderr and emit fixed errors.
- Readiness runs authenticated application-user `SELECT 1` over loopback TCP against the requested database. Ping alone is insufficient.

The example depends on the pinned image entrypoint and must be retested when that image changes. Rebuild API/runner before using the updated prompt. Previously saved documents/volumes remain unchanged; this does not recover half-initialized failed volumes.

## Verification

`pnpm test:compose-validation` checks the exact example against policy/saved validation; provider tests verify prompt inclusion and secret exclusion. `pnpm test:evaluation:runtime` obtains the reference from the actual prompt and runs it in a disposable policy fixture through the shared driver.

Two Docker regressions passed: unchanged C09 credentials, and extended root/application passwords containing quotes, backslashes, dollars, Unicode, SQL-like text, CRLF and trailing newlines. Both verified exact delivery, correct/wrong-password authentication, marker retention over Stop/Start and scoped cleanup. Historical static/provider/policy results are in [history](history.md). No live inference/full benchmark or deployment was performed for this fix.

Implementation references: [pinned-image entrypoint source](https://github.com/docker-library/mysql/blob/master/8.4/docker-entrypoint.sh), [SQL literals](https://dev.mysql.com/doc/refman/8.4/en/string-literals.html), [client binary mode](https://dev.mysql.com/doc/refman/8.4/en/mysql-command-options.html), [mysqladmin behavior](https://dev.mysql.com/doc/refman/8.4/en/mysqladmin.html).
