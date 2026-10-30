# Authentication API

Implemented source for milestone 2's backend and browser slices; all 24 endpoint tests and 28 frontend tests passed in this environment. All paths below start with `/api/v1`. Requests and responses use JSON. No email service or LLM credentials are involved.

| Method/path                | Request                                                          | Successful response                                   |
| -------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------- |
| `POST /auth/register`      | `{ "email": "user@example.com", "password": "a-long-password" }` | 201 token pair and minimal user                       |
| `POST /auth/login`         | Same credentials                                                 | 200 token pair in a new session                       |
| `POST /auth/refresh_token` | `{ "refresh_token": "<latest refresh token>" }`                  | 200 replacement pair for the same session             |
| `GET /auth/me`             | `Authorization: Bearer <access_token>`                           | 200 `{ "id": "<uuid>", "email": "user@example.com" }` |
| `POST /auth/logout`        | `Authorization: Bearer <access_token>`                           | 204, empty body; session revoked                      |

Register, login, and refresh return:

```json
{
  "user": { "id": "<server-generated uuid>", "email": "user@example.com" },
  "access_token": "<signed JWT>",
  "refresh_token": "<opaque random token>",
  "token_type": "Bearer",
  "expires_in": 900
}
```

`expires_in` is seconds, capped at the session's remaining lifetime. Token-bearing responses and current-user responses set `Cache-Control: no-store`. No cookies are set or accepted as authentication. Supply bearer access tokens explicitly; do not put tokens in URLs, logs, or localStorage. The Vue browser client holds credentials in memory and serializes refresh requests.

Emails are trimmed and lowercased, validated as email addresses with ASCII local parts, and limited to 254 characters. Passwords are 12–128 characters and are not trimmed. Unknown fields and incorrect types return 400. Registration conflicts, including a concurrent normalized-email race, return 409. Invalid login credentials return 401 with `Invalid email or password` for both unknown emails and wrong passwords. Missing, invalid, expired, or revoked bearer credentials return 401. Malformed refresh payloads return 400; unknown, expired, consumed, or revoked refresh tokens return 401. Untrusted browser origins return 403; rate limits return 429. Errors use Nest's standard HTTP exception shape without credentials or validation target/value objects.

Access tokens are HS256 JWTs with subject, session ID, token purpose, issuer, audience, unique token ID, and expiry. They last at most 15 minutes. Protected endpoints check the persisted session's user, expiry, and revocation on every request. Refresh tokens are 32 random bytes encoded as base64url; the database stores only SHA-256 hashes. Each refresh consumes the old token and inserts its successor atomically. Consumed hashes remain associated with the session so replay revokes the entire session. Concurrent refresh calls with the same token produce one success and one rejection, then invalidate that session. Refreshing does not extend the absolute seven-day session lifetime. Logout invalidates both token types for that session while leaving other logins active.

Registration, login, and refresh have a ten-request/minute limit per route and observed IP. The current in-memory limiter is for a single API process; behind the scaffold proxy clients share that proxy's limit. Supplied `Origin` headers must exactly match a configured trusted origin. `Sec-Fetch-Site: cross-site` is rejected. Requests without Origin remain available for non-browser clients. CORS and cookie credentials are disabled.

## Browser UI

`/login` and `/register` submit email/password credentials to these endpoints. Successful registration signs in immediately. `/account` requires an in-memory session and loads the user through `/auth/me`; it provides a logout button. Configuration generation remains planned. Errors cover invalid credentials, duplicate email, validation, origin rejection, rate limiting, and connection failures without displaying raw server messages. Recoverable failures preserve form inputs and allow retry; submissions disable the form until completion.

Tokens never enter persistent browser storage or serializable Pinia state. Reloading or closing the page requires login again and does not itself revoke a server session. Refresh is serialized, happens before requests near access expiry or once after a 401, and uses the latest rotated token. Failed refresh clears local credentials and redirects protected pages to login. Logout calls the server; a connection failure leaves a retry option. No periodic session polling is performed.

Run `corepack pnpm test:web` for component, routing, and session-client tests with mocked HTTP responses. These tests need no database, Docker, environment files, or credentials. `corepack pnpm test:api` runs the separate real-MySQL suite; `corepack pnpm test` runs both.

## Persistence and migrations

The committed MySQL migration creates `users`, `sessions`, and `refresh_tokens`, with unique normalized email/token-hash indexes and cascading user/session foreign keys. UUIDs are generated by the server. Passwords use Argon2id (19 MiB, two iterations, one lane). Prisma 7 configuration and generated clients do not load environment files.

With an explicitly exported `DATABASE_URL` pointing to the intended MySQL database:

```bash
corepack pnpm --filter @docker-image-creator/api db:migrate
```

This uses `prisma migrate deploy`, never schema push or a database reset. Compose's API image runs the same migration before startup. Preserve the database volume across restarts. Expired/revoked-session cleanup is not yet automated.

## Checks

```bash
corepack pnpm install
corepack pnpm lint
corepack pnpm format:check
corepack pnpm typecheck
corepack pnpm build
corepack pnpm --filter @docker-image-creator/api prisma:validate
corepack pnpm test
```

The endpoint suite uses Node's test runner, Supertest, actual Nest providers, Prisma, and a fresh MySQL 8.4.11 container. It applies migrations twice to check repeat deployment, tests auth/validation/rotation/replay/expiry/isolation/origin/rate behavior, and removes its own container and anonymous volumes in a `finally` block. It never uses the application's `DATABASE_URL` or environment files. Docker must be available and able to obtain the pinned image. See [local setup](local-setup.md) for the actual verification record and missing prerequisites.
