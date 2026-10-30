import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { createPinia } from "pinia";
import { createMemoryHistory } from "vue-router";
import App from "../src/App.vue";
import { createAppRouter } from "../src/router";
import { useAuthStore } from "../src/auth/store";
import { credentials, deferred, json, tokens, user } from "./helpers";

enableAutoUnmount(afterEach);

describe("authentication pages", () => {
  const fetchMock = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  async function render(
    path = "/login",
    signedIn = false,
    beforeMount?: () => void,
  ) {
    const pinia = createPinia();
    if (signedIn) {
      fetchMock.mockResolvedValueOnce(json(tokens()));
      await useAuthStore(pinia).signIn("login", credentials);
    }
    beforeMount?.();
    const router = createAppRouter(pinia, createMemoryHistory());
    await router.push(path);
    await router.isReady();
    const wrapper = mount(App, { global: { plugins: [pinia, router] } });
    await flushPromises();
    return { wrapper, router, auth: useAuthStore(pinia) };
  }

  async function fill(
    wrapper: ReturnType<typeof mount>,
    email = credentials.email,
    password = credentials.password,
  ) {
    await wrapper.get('input[name="email"]').setValue(email);
    await wrapper.get('input[name="password"]').setValue(password);
  }

  it("redirects direct and unknown unauthenticated routes to login", async () => {
    const { wrapper, router } = await render("/account");
    expect(router.currentRoute.value.path).toBe("/login");
    expect(wrapper.get("h1").text()).toBe("Welcome back");
    expect(fetchMock).not.toHaveBeenCalled();
    await router.push("/configs");
    expect(router.currentRoute.value.path).toBe("/login");
  });

  it("links login and registration, resets passwords between pages, and sets password-manager hints", async () => {
    const { wrapper, router } = await render();
    expect(wrapper.get("#password").attributes("autocomplete")).toBe(
      "current-password",
    );
    expect(wrapper.get('label[for="email"]').text()).toBe("Email address");
    await fill(wrapper);
    await wrapper.get('a[href="/register"]').trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/register");
    expect(wrapper.get("#password").attributes("autocomplete")).toBe(
      "new-password",
    );
    expect(wrapper.get<HTMLInputElement>("#password").element.value).toBe("");
  });

  it.each(["/login", "/register"])(
    "validates %s locally before sending credentials",
    async (path) => {
      const { wrapper } = await render(path);
      await fill(wrapper, "bad-email");
      await wrapper.get("form").trigger("submit");
      expect(wrapper.get('[role="alert"]').text()).toBe(
        "Enter a valid email address.",
      );
      await fill(wrapper, credentials.email, "too-short");
      await wrapper.get("form").trigger("submit");
      expect(wrapper.get('[role="alert"]').text()).toContain("12–128");
      await fill(wrapper, credentials.email, "x".repeat(129));
      await wrapper.get("form").trigger("submit");
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it.each(["login", "register"])(
    "completes %s, normalizes email, preserves password spaces, and displays /me",
    async (mode) => {
      const { wrapper, router } = await render(`/${mode}`);
      fetchMock
        .mockResolvedValueOnce(json(tokens(), mode === "register" ? 201 : 200))
        .mockResolvedValueOnce(
          json({ ...user, email: "verified@example.com" }),
        );
      await fill(wrapper, "  PERSON@EXAMPLE.COM  ");
      await wrapper.get("form").trigger("submit");
      await flushPromises();
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        `/api/v1/auth/${mode}`,
        expect.objectContaining({ body: JSON.stringify(credentials) }),
      );
      expect(router.currentRoute.value.path).toBe("/account");
      expect(wrapper.text()).toContain("verified@example.com");
      await router.push("/register");
      expect(router.currentRoute.value.path).toBe("/account");
    },
  );

  it.each([
    ["/login", 401, "Invalid email or password."],
    ["/register", 409, "already exists"],
    ["/register", 400, "Check your email and password"],
    ["/login", 429, "wait a minute"],
    ["/login", 403, "trusted origin"],
    ["/login", 503, "Please try again"],
  ] as const)(
    "shows safe %s errors for %s and preserves form input",
    async (path, status, message) => {
      const { wrapper } = await render(path);
      fetchMock.mockResolvedValueOnce(
        json({ message: "<script>sensitive server details</script>" }, status),
      );
      await fill(wrapper);
      await wrapper.get("form").trigger("submit");
      await flushPromises();
      expect(wrapper.get('[role="alert"]').text()).toContain(message);
      expect(wrapper.text()).not.toContain("sensitive server details");
      expect(wrapper.get<HTMLInputElement>("#email").element.value).toBe(
        credentials.email,
      );
      expect(wrapper.get<HTMLInputElement>("#password").element.value).toBe(
        credentials.password,
      );
    },
  );

  it("prevents duplicate submissions and allows retry after a network failure", async () => {
    const { wrapper } = await render();
    const pending = deferred<Response>();
    fetchMock.mockReturnValueOnce(pending.promise);
    await fill(wrapper);
    await wrapper.get("form").trigger("submit");
    await wrapper.get("form").trigger("submit");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(wrapper.get("fieldset").attributes("disabled")).toBeDefined();
    expect(wrapper.text()).toContain("Signing in…");
    pending.resolve(json({}, 503));
    await flushPromises();
    expect(wrapper.get("fieldset").attributes("disabled")).toBeUndefined();
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    await wrapper.get("form").trigger("submit");
    await flushPromises();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(wrapper.get('[role="alert"]').text()).toContain(
      "Unable to reach the API",
    );
  });

  it("returns to login when the session is revoked, without leaving account data visible", async () => {
    fetchMock.mockImplementation(async (path) =>
      String(path).endsWith("/login") ? json(tokens()) : json({}, 401),
    );
    const { wrapper, router, auth } = await render("/account", true);
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/login");
    expect(auth.hasSession).toBe(false);
    expect(wrapper.text()).toContain("Your session has ended");
    expect(wrapper.text()).not.toContain(user.email);
  });

  it("retries a failed account check and logs out through the endpoint", async () => {
    const { wrapper, router, auth } = await render("/account", true, () => {
      fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    });
    expect(wrapper.get('[role="alert"]').text()).toContain("Unable to reach");
    fetchMock.mockResolvedValueOnce(json(user));
    await wrapper.get("button").trigger("click");
    await flushPromises();
    expect(wrapper.text()).toContain(user.email);
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    await wrapper.get("button.secondary").trigger("click");
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain(
      "Could not confirm logout",
    );
    expect(auth.hasSession).toBe(true);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await wrapper.get("button.secondary").trigger("click");
    await flushPromises();
    expect(auth.hasSession).toBe(false);
    expect(router.currentRoute.value.path).toBe("/login");
    await router.push("/account");
    expect(router.currentRoute.value.path).toBe("/login");
    expect(wrapper.text()).not.toContain(user.email);
  });
});
