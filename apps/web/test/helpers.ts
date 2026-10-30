import type { AuthResponse, AuthUser } from "@docker-image-creator/contracts";

export const credentials = {
  email: "person@example.com",
  password: "  a-long-password  ",
};
export const user: AuthUser = { id: "test-user-id", email: credentials.email };
export function tokens(suffix = "one", expires = 900): AuthResponse {
  return {
    user,
    access_token: `test-access-${suffix}`,
    refresh_token: `test-refresh-${suffix}`,
    token_type: "Bearer",
    expires_in: expires,
  };
}
export function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
