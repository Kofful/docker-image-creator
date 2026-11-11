# Authentication API

Email/password registration, login, current user and logout are implemented without email transport. Routes use `/api/v1`, JSON and no-store credential/user responses.

| Method/path                | Request                                                          | Success                         |
| -------------------------- | ---------------------------------------------------------------- | ------------------------------- |
| `POST /auth/register`      | `{ "email": "user@example.com", "password": "a-long-password" }` | 201 user and token pair         |
| `POST /auth/login`         | Same credentials                                                 | 200 user and new session's pair |
| `POST /auth/refresh_token` | `{ "refresh_token": "<latest token>" }`                          | 200 rotated pair                |
| `GET /auth/me`             | Bearer access token                                              | 200 minimal user                |
| `POST /auth/logout`        | Bearer access token                                              | 204, current session revoked    |

```json
{
  "user": { "id": "<UUID>", "email": "user@example.com" },
  "access_token": "<signed JWT>",
  "refresh_token": "<opaque token>",
  "token_type": "Bearer",
  "expires_in": 900
}
```

`expires_in` is seconds capped by remaining session lifetime. No authentication cookies are accepted/set; send bearer tokens explicitly, never in URLs or persistent browser storage.

## Validation and errors

Emails are trimmed/lowercased, ASCII-local-part validated and ≤254 characters. Passwords retain whitespace and require 12–128 characters. Argon2id uses 19 MiB, two iterations and one lane. Unknown fields/types return 400; duplicate normalized email returns 409. Invalid login uses generic 401 `Invalid email or password`, including unknown accounts. Invalid/expired/revoked credentials return 401; origin failure 403; rate limit 429. Public validation errors omit credential values.

Register/login/refresh are limited to ten requests/minute per route/observed peer IP in one API process. Proxy headers are untrusted, so proxied clients share a limit; counters reset on restart and are not shared across replicas. Supplied Origin must exactly match trusted origins; cross-site Fetch Metadata is rejected. Nonbrowser requests without Origin are allowed. CORS/cookie credentials are disabled.

## Rotation and revocation

HS256 access JWTs bind subject/session/purpose/issuer/audience/token ID and last at most 15 minutes. Every protected request checks the persisted session's owner, expiry and revocation. Sessions expire absolutely after seven days; refresh does not extend them.

Refresh tokens are 32 random bytes; only SHA-256 hashes persist. A transaction consumes the old token and inserts its successor. Consumed hashes remain for replay detection: reuse revokes the whole session, including tokens issued by a racing refresh. Clients must serialize refreshes. Logout revokes only the caller's session. Active terminals recheck that session every second.

## Browser and persistence

Vue's private session-client closure holds tokens outside Pinia's serializable state/storage. Successful registration signs in; protected account/configuration/terminal pages require the session. Reload/closure loses local tokens but does not revoke the server session. Refresh occurs near expiry or once after 401, with one shared in-flight request and latest-token reuse. Lost/failed refresh clears local credentials; retryable logout failure retains a retry control. No periodic session polling occurs on ordinary pages.

Prisma migrations create users/sessions/hashed refresh records with uniqueness/foreign keys; application/Prisma tooling does not load environment files. With an explicitly supplied intended `DATABASE_URL`, `pnpm --filter @docker-image-creator/api db:migrate` deploys committed migrations; Compose does so on API startup. Session cleanup/quotas, cookie transport, verification/reset emails, OAuth and MFA are deferred.

`pnpm test:web` exercises Vue/router/session behavior with mocked HTTP. `pnpm test:api` uses real Nest handlers and disposable MySQL 8.4.11 with migrations replayed; it checks auth/validation/rotation/replay/expiry/ownership/origin/rate behavior and removes its own resources. [History](history.md) records results.
