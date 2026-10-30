import { computed, readonly, shallowRef } from "vue";
import type {
  AuthResponse,
  AuthUser,
  CredentialsRequest,
  RefreshTokenRequest,
} from "@docker-image-creator/contracts";

export class AuthError extends Error {
  constructor(public readonly status: number) {
    super("Authentication request failed");
  }
}

// Credentials stay in this closure: never in browser storage, URLs, or Pinia state.
export function createAuthSession() {
  const user = shallowRef<AuthUser | null>(null);
  let session: (AuthResponse & { expiresAt: number }) | null = null;
  let refreshPromise: Promise<void> | null = null;
  let generation = 0;

  function clear() {
    generation += 1;
    session = null;
    user.value = null;
  }

  async function send(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetch(path, {
        ...init,
        credentials: "omit",
        cache: "no-store",
        signal: init.signal
          ? AbortSignal.any([init.signal, AbortSignal.timeout(10000)])
          : AbortSignal.timeout(10000),
      });
    } catch {
      throw new AuthError(0);
    }
  }

  async function tokenRequest(
    path: "register" | "login" | "refresh_token",
    body: CredentialsRequest | RefreshTokenRequest,
  ): Promise<AuthResponse & { expiresAt: number }> {
    const startedAt = Date.now();
    const response = await send(`/api/v1/auth/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new AuthError(response.status);
    try {
      const pair: AuthResponse = await response.json();
      if (
        !pair.user?.id ||
        !pair.user.email ||
        !pair.access_token ||
        !pair.refresh_token ||
        pair.token_type !== "Bearer" ||
        !Number.isFinite(pair.expires_in) ||
        pair.expires_in <= 0
      )
        throw new Error("Invalid token response");
      return { ...pair, expiresAt: startedAt + pair.expires_in * 1000 };
    } catch {
      throw new AuthError(0);
    }
  }

  async function signIn(
    mode: "register" | "login",
    credentials: CredentialsRequest,
  ) {
    const attempt = ++generation;
    const next = await tokenRequest(mode, credentials);
    if (attempt !== generation) throw new AuthError(401);
    session = next;
    user.value = next.user;
  }

  function refresh(): Promise<void> {
    if (refreshPromise) return refreshPromise;
    const active = session;
    if (!active) return Promise.reject(new AuthError(401));
    const pending = (async () => {
      try {
        const next = await tokenRequest("refresh_token", {
          refresh_token: active.refresh_token,
        });
        if (session !== active) throw new AuthError(401);
        session = next;
        user.value = next.user;
      } catch (error) {
        // A lost response may already have consumed the token. Never replay it.
        if (session === active) clear();
        throw error;
      } finally {
        refreshPromise = null;
      }
    })();
    refreshPromise = pending;
    return pending;
  }

  async function requestApi(
    path: string,
    init: RequestInit = {},
  ): Promise<Response> {
    if (!path.startsWith("/api/v1/") || path.includes("://"))
      throw new AuthError(0);
    const attempt = generation;
    if (!session) throw new AuthError(401);
    if (session.expiresAt <= Date.now() + 5000) await refresh();
    if (attempt !== generation) throw new AuthError(401);
    const request = () =>
      send(path, {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init.headers).entries()),
          Authorization: `Bearer ${session?.access_token}`,
        },
      });
    const token = session?.access_token;
    let response = await request();
    if (attempt !== generation) throw new AuthError(401);
    if (response.status === 401) {
      // Another request may already have rotated this access token.
      if (token === session?.access_token) await refresh();
      if (attempt !== generation) throw new AuthError(401);
      response = await request();
    }
    if (attempt !== generation) throw new AuthError(401);
    if (response.status === 401) clear();
    if (!response.ok) throw new AuthError(response.status);
    return response;
  }

  async function loadUser() {
    const attempt = generation;
    const response = await requestApi("/api/v1/auth/me");
    let current: AuthUser;
    try {
      current = await response.json();
      if (!current.id || !current.email)
        throw new Error("Invalid user response");
    } catch {
      throw new AuthError(0);
    }
    if (attempt === generation) user.value = current;
  }

  async function signOut() {
    try {
      await requestApi("/api/v1/auth/logout", { method: "POST" });
    } catch (error) {
      // Expired/revoked credentials already lost access. Other failures are retryable.
      if (!(error instanceof AuthError) || error.status !== 401) throw error;
    }
    clear();
  }

  return {
    user: readonly(user),
    hasSession: computed(() => user.value !== null),
    signIn,
    loadUser,
    signOut,
    requestApi,
  };
}
