import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia } from "pinia";
import { createMemoryHistory } from "vue-router";
import App from "../src/App.vue";
import { createAppRouter } from "../src/router";
import { useAuthStore } from "../src/auth/store";
import type {
  ConfigResponse,
  GenerationResponse,
} from "@docker-image-creator/contracts";
import { credentials, json, tokens } from "./helpers";

const generation: GenerationResponse = {
  id: "generation-one",
  configId: "config-one",
  status: "succeeded",
  stage: "complete",
  provider: "fake",
  error: null,
  revisionId: "revision-one",
  createdAt: "2026-10-30T00:00:00.000Z",
  completedAt: null,
  runtimeValidation: "not_performed",
  cleanupPending: false,
};
const config: ConfigResponse = {
  id: "config-one",
  name: "My starter",
  description: "",
  services: [],
  generation,
  revision: {
    id: "revision-one",
    version: 1,
    compose: '{"services":{}}',
    digest: "digest",
    artifactPath: "private/compose.yaml",
  },
};

describe("configuration views", () => {
  const fetchMock = vi.fn<typeof fetch>();
  let wrapper: VueWrapper | undefined;
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
  });
  async function open(path: string) {
    const pinia = createPinia();
    fetchMock.mockResolvedValueOnce(json(tokens()));
    await useAuthStore(pinia).signIn("login", credentials);
    const router = createAppRouter(pinia, createMemoryHistory());
    await router.push(path);
    await router.isReady();
    wrapper = mount(App, { global: { plugins: [pinia, router] } });
    await flushPromises();
    return router;
  }
  it("retries lost creation with the same key and opens the saved result", async () => {
    await open("/configs/new");
    fetchMock.mockRejectedValueOnce(new TypeError("lost response"));
    await wrapper!.get("#config-name").setValue("My starter");
    await wrapper!.get("form").trigger("submit");
    await flushPromises();
    expect(wrapper!.text()).toContain("Check your configurations");
    fetchMock
      .mockResolvedValueOnce(
        json(
          {
            configId: "config-one",
            generationId: "generation-one",
            status: "queued",
            statusUrl: "/api/v1/generations/generation-one",
            pollAfterMs: 2000,
          },
          202,
        ),
      )
      .mockResolvedValueOnce(json(config));
    await wrapper!.get("form").trigger("submit");
    await flushPromises();
    const posts = fetchMock.mock.calls.filter(
      ([path, init]) => path === "/api/v1/configs" && init?.method === "POST",
    );
    expect(posts).toHaveLength(2);
    expect(new Headers(posts[0]![1]!.headers).get("Idempotency-Key")).toBe(
      new Headers(posts[1]![1]!.headers).get("Idempotency-Key"),
    );
    expect(wrapper!.text()).toContain("Compose saved");
    expect(wrapper!.get("pre").text()).toBe(config.revision!.compose);
  });
  it("resumes polling an existing configuration without creating another job", async () => {
    let details = 0;
    // The first response is consumed by login in open().
    fetchMock.mockImplementation(async (path) => {
      if (path === "/api/v1/generations/generation-one")
        return json(generation);
      details++;
      return json(
        details === 1
          ? {
              ...config,
              revision: null,
              generation: {
                ...generation,
                status: "running",
                stage: "generating",
              },
            }
          : config,
      );
    });
    await open("/configs/config-one");
    await flushPromises();
    expect(
      fetchMock.mock.calls.some(
        ([path]) => path === "/api/v1/generations/generation-one",
      ),
    ).toBe(true);
    expect(
      fetchMock.mock.calls.some(
        ([path, init]) => path === "/api/v1/configs" && init?.method === "POST",
      ),
    ).toBe(false);
    expect(wrapper!.text()).toContain("Compose saved");
  });
});
