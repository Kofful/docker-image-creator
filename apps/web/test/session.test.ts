import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises } from "@vue/test-utils";
import { createPinia } from "pinia";
import { createAuthSession } from "../src/auth/session";
import { useAuthStore } from "../src/auth/store";
import { credentials, deferred, json, tokens, user } from "./helpers";

describe("in-memory authentication", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.useRealTimers());

  it.each(["login", "register"] as const)(
    "uses %s and verifies the current user with a bearer token",
    async (mode) => {
      fetchMock
        .mockResolvedValueOnce(json(tokens()))
        .mockResolvedValueOnce(json(user));
      const auth = createAuthSession();
      await auth.signIn(mode, credentials);
      await auth.loadUser();
      expect(auth.user.value).toEqual(user);
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        `/api/v1/auth/${mode}`,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify(credentials),
          credentials: "omit",
          cache: "no-store",
        }),
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        "/api/v1/auth/me",
        expect.objectContaining({
          headers: { Authorization: "Bearer test-access-one" },
          credentials: "omit",
          cache: "no-store",
        }),
      );
    },
  );

  it("keeps tokens out of Pinia state and browser storage, and starts a new page unauthenticated", async () => {
    const localWrite = vi.spyOn(Storage.prototype, "setItem");
    const cookieWrite = vi.spyOn(Document.prototype, "cookie", "set");
    fetchMock.mockResolvedValueOnce(json(tokens()));
    const pinia = createPinia();
    await useAuthStore(pinia).signIn("login", credentials);
    const state = JSON.stringify(pinia.state.value);
    expect(state).toContain(user.email);
    expect(state).not.toContain("test-access");
    expect(state).not.toContain("test-refresh");
    expect(state).not.toContain(credentials.password);
    expect(localWrite).not.toHaveBeenCalled();
    expect(cookieWrite).not.toHaveBeenCalled();
    expect(useAuthStore(createPinia()).hasSession).toBe(false);
  });

  it("rotates only once when concurrent requests find an expiring token", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const pending = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(json(tokens()))
      .mockReturnValueOnce(pending.promise)
      .mockImplementation(async () => json(user));
    const auth = createAuthSession();
    await auth.signIn("login", credentials);
    vi.setSystemTime(Date.now() + 900000);
    const first = auth.loadUser();
    const second = auth.loadUser();
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/v1/auth/refresh_token",
      expect.objectContaining({
        body: JSON.stringify({ refresh_token: "test-refresh-one" }),
      }),
    );
    pending.resolve(json(tokens("two")));
    await Promise.all([first, second]);
    for (const [, init] of fetchMock.mock.calls.slice(2)) {
      expect(init?.headers).toEqual({
        Authorization: "Bearer test-access-two",
      });
    }
  });

  it("handles a delayed 401 without rotating the already-replaced token again", async () => {
    const delayed = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(json(tokens()))
      .mockResolvedValueOnce(json({}, 401))
      .mockReturnValueOnce(delayed.promise)
      .mockResolvedValueOnce(json(tokens("two")))
      .mockImplementation(async () => json(user));
    const auth = createAuthSession();
    await auth.signIn("login", credentials);
    const first = auth.loadUser();
    const second = auth.loadUser();
    await first;
    delayed.resolve(json({}, 401));
    await second;
    expect(
      fetchMock.mock.calls.filter(([path]) =>
        String(path).endsWith("/refresh_token"),
      ),
    ).toHaveLength(1);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/v1/auth/me",
      expect.objectContaining({
        headers: { Authorization: "Bearer test-access-two" },
      }),
    );
  });

  it("bounds a 401 retry, clearing a session rejected after refresh", async () => {
    fetchMock
      .mockResolvedValueOnce(json(tokens()))
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json(tokens("two")))
      .mockResolvedValueOnce(json({}, 401));
    const auth = createAuthSession();
    await auth.signIn("login", credentials);
    await expect(auth.loadUser()).rejects.toMatchObject({ status: 401 });
    expect(auth.hasSession.value).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it.each([401, 429, 500])(
    "clears credentials when refresh fails with %s",
    async (status) => {
      fetchMock
        .mockResolvedValueOnce(json(tokens()))
        .mockResolvedValueOnce(json({}, 401))
        .mockResolvedValueOnce(json({}, status));
      const auth = createAuthSession();
      await auth.signIn("login", credentials);
      await expect(auth.loadUser()).rejects.toMatchObject({ status });
      expect(auth.hasSession.value).toBe(false);
      await expect(auth.loadUser()).rejects.toMatchObject({ status: 401 });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    },
  );

  it("does not replay a refresh token after a lost response", async () => {
    fetchMock
      .mockResolvedValueOnce(json(tokens()))
      .mockResolvedValueOnce(json({}, 401))
      .mockRejectedValueOnce(
        new TypeError("network failure with sensitive details"),
      );
    const auth = createAuthSession();
    await auth.signIn("login", credentials);
    await expect(auth.loadUser()).rejects.toMatchObject({
      status: 0,
      message: "Authentication request failed",
    });
    await expect(auth.loadUser()).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("revokes the server session on logout and ignores a late user response", async () => {
    const delayed = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(json(tokens()))
      .mockReturnValueOnce(delayed.promise)
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const auth = createAuthSession();
    await auth.signIn("login", credentials);
    const loading = auth.loadUser();
    const result = expect(loading).rejects.toMatchObject({ status: 401 });
    await auth.signOut();
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/v1/auth/logout",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer test-access-one" },
      }),
    );
    delayed.resolve(json(user));
    await result;
    expect(auth.user.value).toBeNull();
  });

  it("retains credentials on a retryable logout failure", async () => {
    fetchMock
      .mockResolvedValueOnce(json(tokens()))
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const auth = createAuthSession();
    await auth.signIn("login", credentials);
    await expect(auth.signOut()).rejects.toMatchObject({ status: 0 });
    expect(auth.hasSession.value).toBe(true);
    await auth.signOut();
    expect(auth.hasSession.value).toBe(false);
  });

  it("rejects malformed successful token responses without authenticating", async () => {
    fetchMock.mockResolvedValueOnce(json({ user }));
    const auth = createAuthSession();
    await expect(auth.signIn("login", credentials)).rejects.toMatchObject({
      status: 0,
    });
    expect(auth.hasSession.value).toBe(false);
  });
});
