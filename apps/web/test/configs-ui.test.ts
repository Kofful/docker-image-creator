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
  RuntimeOperationResponse,
} from "@docker-image-creator/contracts";
import { credentials, json, tokens } from "./helpers";

const generation: GenerationResponse = {
  id: "generation-one",
  configId: "config-one",
  status: "succeeded",
  stage: "complete",
  provider: "openrouter",
  inputVersion: 2,
  model: "google/gemma-4-26b-a4b-it:free",
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
  let suppliedEnvironment = true;
  beforeEach(() => {
    suppliedEnvironment = true;
    vi.stubGlobal("fetch", (path: RequestInfo | URL, init?: RequestInit) =>
      path === "/api/v1/config-input-options"
        ? Promise.resolve(json({ suppliedEnvironment }))
        : typeof path === "string" && path.endsWith("/services")
          ? Promise.resolve(
              json({
                configId: config.id,
                revisionId: null,
                operationId: null,
                services: [],
              }),
            )
          : typeof path === "string" && path.endsWith("/deployment")
            ? Promise.resolve(json({}, 404))
            : fetchMock(path, init),
    );
    fetchMock.mockReset();
    fetchMock.mockResolvedValueOnce(json(tokens()));
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
  });
  async function open(path: string) {
    const pinia = createPinia();
    await useAuthStore(pinia).signIn("login", credentials);
    const router = createAppRouter(pinia, createMemoryHistory());
    await router.push(path);
    await router.isReady();
    wrapper = mount(App, {
      attachTo: document.body,
      global: { plugins: [pinia, router] },
    });
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
  it("shows legacy configurations as unsupported and disables lifecycle actions", async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        ...config,
        generation: {
          ...generation,
          provider: "fake",
          inputVersion: undefined,
          model: undefined,
        },
      }),
    );
    await open("/configs/config-one");
    await flushPromises();
    expect(wrapper!.text()).toContain("Legacy configurations are unsupported");
    const start = wrapper!
      .findAll("button")
      .find((button) => button.text() === "Start")!;
    expect(start.attributes("disabled")).toBeDefined();
    await start.trigger("click");
    expect(
      fetchMock.mock.calls.some(
        ([path]) => typeof path === "string" && path.endsWith("/start"),
      ),
    ).toBe(false);
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

  it("masks supplied values, validates completeness, and submits shared bindings without browser persistence", async () => {
    suppliedEnvironment = true;
    const storage = vi.spyOn(Storage.prototype, "setItem");
    await open("/configs/new");
    await wrapper!.get("#config-name").setValue("Shared values");
    await wrapper!.get("[data-add-value]").trigger("click");
    await wrapper!.get("#value-key-0").setValue("shared");
    await wrapper!.get("#value-purpose-0").setValue("Application setting");
    const secret = " $money 'quoted' \\\\ # trailing ";
    await wrapper!.get("#value-content-0").setValue(secret);
    expect(wrapper!.get("#value-content-0").attributes("type")).toBe(
      "password",
    );
    expect(wrapper!.text()).not.toContain(secret);
    await wrapper!.get("form").trigger("submit");
    expect(wrapper!.get('[role="alert"]').text()).toContain(
      "Assign every supplied value",
    );
    for (const name of ["PATH", "DOCKER_HOST"]) {
      await wrapper!.get('[data-add-binding="0"]').trigger("click");
      const index = name === "PATH" ? 0 : 1;
      await wrapper!.get(`#binding-name-${index}`).setValue(name);
      await wrapper!.get(`#binding-value-${index}`).setValue("shared");
    }
    fetchMock.mockRejectedValueOnce(new TypeError("lost response"));
    await wrapper!.get("form").trigger("submit");
    await flushPromises();
    const post = fetchMock.mock.calls.find(
      ([path, init]) => path === "/api/v1/configs" && init?.method === "POST",
    )!;
    expect(JSON.parse(post[1]!.body as string)).toMatchObject({
      inputVersion: 2,
      environmentValues: [
        { key: "shared", value: secret, purpose: "Application setting" },
      ],
      environmentBindings: [
        { service: "app", name: "PATH", valueKey: "shared" },
        { service: "app", name: "DOCKER_HOST", valueKey: "shared" },
      ],
    });
    expect(storage).not.toHaveBeenCalled();
    expect(wrapper!.text()).not.toContain(secret);
  });

  it("requires database passwords and reports validation failures without exposing values", async () => {
    suppliedEnvironment = true;
    await open("/configs/new");
    await wrapper!.get("#config-name").setValue("Database");
    await wrapper!.get("#service-image-0").setValue("mysql");
    expect(wrapper!.text()).toContain("MYSQL_ROOT_PASSWORD, MYSQL_PASSWORD");
    await wrapper!.get("form").trigger("submit");
    expect(wrapper!.get('[role="alert"]').text()).toContain(
      "required database passwords",
    );
    expect(
      fetchMock.mock.calls.some(
        ([path, init]) => path === "/api/v1/configs" && init?.method === "POST",
      ),
    ).toBe(false);
  });

  it("preserves multiline values and updates bindings when service names and value keys change", async () => {
    suppliedEnvironment = true;
    await open("/configs/new");
    await wrapper!.get("[data-add-value]").trigger("click");
    const reveal = wrapper!.get('button[aria-pressed="false"]');
    await reveal.trigger("click");
    expect(wrapper!.get("#value-content-0").element.tagName).toBe("TEXTAREA");
    const secret = "first $line\nsecond \\line #";
    await wrapper!.get("#value-content-0").setValue(secret);
    await wrapper!.get('button[aria-pressed="true"]').trigger("click");
    expect(wrapper!.get("#value-content-0").attributes("type")).toBe(
      "password",
    );
    expect(
      wrapper!.get("#value-content-0").attributes("readonly"),
    ).toBeDefined();
    expect(wrapper!.text()).not.toContain(secret);
    await wrapper!.get('[data-add-binding="0"]').trigger("click");
    await wrapper!.get("#binding-name-0").setValue("TOKEN");
    await wrapper!.get("#binding-value-0").setValue("value-1");
    await wrapper!.get("#value-key-0").setValue("renamed");
    await wrapper!.get("#service-name-0").setValue("backend");
    expect(wrapper!.text()).toContain("backend environment");
    expect(
      (wrapper!.get("#binding-value-0").element as HTMLSelectElement).value,
    ).toBe("renamed");
    await wrapper!.get('button[aria-pressed="false"]').trigger("click");
    expect(
      (wrapper!.get("#value-content-0").element as HTMLTextAreaElement).value,
    ).toBe(secret);
  });

  it("confirms the selected list item, disables duplicate deletion, and preserves other items", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    fetchMock.mockResolvedValueOnce(
      json([config, { ...config, id: "config-two", name: "Other starter" }]),
    );
    await open("/configs");
    let complete!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        complete = resolve;
      }),
    );
    const button = wrapper!.get('button[aria-label="Delete My starter"]');
    await button.trigger("click");
    expect(confirm).toHaveBeenCalledWith(
      expect.stringContaining('Delete "My starter"?'),
    );
    expect(button.attributes("disabled")).toBeDefined();
    expect(button.attributes("aria-busy")).toBe("true");
    await button.trigger("click");
    expect(
      fetchMock.mock.calls.filter(([, init]) => init?.method === "DELETE"),
    ).toHaveLength(1);
    complete(new Response(null, { status: 204 }));
    await flushPromises();
    expect(wrapper!.find('a[href="/configs/config-one"]').exists()).toBe(false);
    expect(wrapper!.get('a[href="/configs/config-two"]').text()).toBe(
      "Other starter",
    );
    expect(wrapper!.text()).toContain("Configuration removed.");
    const deletion = fetchMock.mock.calls.find(
      ([, init]) => init?.method === "DELETE",
    );
    expect(deletion?.[0]).toBe("/api/v1/configs/config-one");
    expect(new Headers(deletion?.[1]?.headers).get("Authorization")).toMatch(
      /^Bearer /,
    );
  });

  it.each(["/configs", "/configs/config-one"])(
    "leaves %s unchanged when confirmation is cancelled",
    async (path) => {
      vi.spyOn(window, "confirm").mockReturnValue(false);
      fetchMock.mockResolvedValueOnce(
        json(path === "/configs" ? [config] : config),
      );
      const router = await open(path);
      await wrapper!
        .get('button[aria-label="Delete My starter"]')
        .trigger("click");
      await flushPromises();
      expect(router.currentRoute.value.path).toBe(path);
      expect(wrapper!.text()).toContain("My starter");
      expect(
        fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE"),
      ).toBe(false);
    },
  );

  it("returns from deleted detail to the list and shows its empty state", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fetchMock.mockResolvedValueOnce(json(config));
    const router = await open("/configs/config-one");
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json([]));
    await wrapper!
      .get('button[aria-label="Delete My starter"]')
      .trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/configs");
    expect(wrapper!.text()).toContain("No configurations yet.");
    expect(wrapper!.find("pre").exists()).toBe(false);
  });

  it("does not restore a deleted row when an earlier list refresh completes", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    fetchMock.mockResolvedValueOnce(json([config]));
    await open("/configs");
    let finish!: (response: Response) => void;
    fetchMock
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await wrapper!.get("button.secondary").trigger("click");
    await wrapper!
      .get('button[aria-label="Delete My starter"]')
      .trigger("click");
    await flushPromises();
    finish(json([config]));
    await flushPromises();
    expect(wrapper!.text()).toContain("No configurations yet.");
    expect(wrapper!.find('a[href="/configs/config-one"]').exists()).toBe(false);
  });

  it.each(["/configs", "/configs/config-one"])(
    "can delete a failed generation with no revision from %s",
    async (path) => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      const failed: ConfigResponse = {
        ...config,
        revision: null,
        generation: { ...generation, status: "failed" },
      };
      fetchMock.mockResolvedValueOnce(
        json(path === "/configs" ? [failed] : failed),
      );
      await open(path);
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
      if (path !== "/configs") fetchMock.mockResolvedValueOnce(json([]));
      const button = wrapper!.get('button[aria-label="Delete My starter"]');
      expect(button.attributes("disabled")).toBeUndefined();
      await button.trigger("click");
      await flushPromises();
      expect(wrapper!.text()).toContain("No configurations yet.");
    },
  );

  it.each(["/configs", "/configs/config-one"])(
    "reconciles an already deleted configuration on %s",
    async (path) => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      fetchMock.mockResolvedValueOnce(
        json(path === "/configs" ? [config] : config),
      );
      const router = await open(path);
      fetchMock.mockResolvedValueOnce(json({}, 404));
      if (path !== "/configs") fetchMock.mockResolvedValueOnce(json([]));
      await wrapper!
        .get('button[aria-label="Delete My starter"]')
        .trigger("click");
      await flushPromises();
      expect(router.currentRoute.value.path).toBe("/configs");
      expect(wrapper!.text()).toContain("No configurations yet.");
      expect(wrapper!.find('[role="alert"]').exists()).toBe(false);
    },
  );

  it.each(["queued", "running"] as const)(
    "disables list deletion during %s generation and enables it after refresh",
    async (status) => {
      const confirm = vi.spyOn(window, "confirm");
      fetchMock.mockResolvedValueOnce(
        json([{ ...config, generation: { ...generation, status } }]),
      );
      await open("/configs");
      const button = wrapper!.get('button[aria-label="Delete My starter"]');
      expect(button.attributes("disabled")).toBeDefined();
      const trigger = wrapper!.get(".delete-tooltip-trigger");
      const tooltip = wrapper!.get('[role="tooltip"]');
      expect(tooltip.isVisible()).toBe(false);
      expect(trigger.attributes("tabindex")).toBe("0");
      expect(button.attributes("aria-describedby")).toBe(
        tooltip.attributes("id"),
      );
      await trigger.trigger("focusin");
      expect(tooltip.isVisible()).toBe(true);
      expect(tooltip.text()).toBe(
        "Deletion is available after generation finishes.",
      );
      await trigger.trigger("keydown", { key: "Escape" });
      expect(tooltip.isVisible()).toBe(false);
      await trigger.trigger("focusout");
      await button.trigger("click");
      expect(confirm).not.toHaveBeenCalled();
      fetchMock.mockResolvedValueOnce(json([config]));
      await wrapper!.get("button.secondary").trigger("click");
      await flushPromises();
      expect(button.attributes("disabled")).toBeUndefined();
      expect(wrapper!.find('[role="tooltip"]').exists()).toBe(false);
      expect(trigger.attributes("tabindex")).toBeUndefined();
    },
  );

  it("enables detail deletion when polling finishes", async () => {
    let finish!: (response: Response) => void;
    fetchMock
      .mockResolvedValueOnce(
        json({
          ...config,
          revision: null,
          generation: { ...generation, status: "running" },
        }),
      )
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
      );
    await open("/configs/config-one");
    const button = wrapper!.get('button[aria-label="Delete My starter"]');
    expect(button.attributes("disabled")).toBeDefined();
    fetchMock.mockResolvedValueOnce(json(config));
    finish(json(generation));
    await flushPromises();
    expect(button.attributes("disabled")).toBeUndefined();
  });

  it.each([
    [403, "Generation is still in progress"],
    [500, "Could not confirm deletion"],
    [0, "Could not confirm deletion"],
  ])(
    "keeps a configuration visible after deletion failure %s and allows retry",
    async (status, message) => {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      fetchMock.mockResolvedValueOnce(json([config]));
      await open("/configs");
      if (status === 0)
        fetchMock.mockRejectedValueOnce(new TypeError("lost response"));
      else fetchMock.mockResolvedValueOnce(json({}, status));
      const button = wrapper!.get('button[aria-label="Delete My starter"]');
      await button.trigger("click");
      await flushPromises();
      expect(wrapper!.get('[role="alert"]').text()).toContain(message);
      expect(wrapper!.get('a[href="/configs/config-one"]').text()).toBe(
        config.name,
      );
      expect(button.attributes("disabled")).toBeUndefined();
      fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
      await button.trigger("click");
      await flushPromises();
      expect(wrapper!.text()).toContain("No configurations yet.");
    },
  );
  it("keeps a list entry until runner cleanup succeeds and then stops fetching", async () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(window, "confirm").mockReturnValue(true);
      fetchMock.mockResolvedValueOnce(json([config]));
      await open("/configs");
      const operation: RuntimeOperationResponse = {
        id: "delete-one",
        configId: config.id,
        revisionId: config.revision!.id,
        type: "delete",
        status: "queued",
        stage: "queued",
        error: null,
        cleanupPending: false,
        createdAt: "2026-11-02T00:00:00.000Z",
        completedAt: null,
      };
      fetchMock
        .mockResolvedValueOnce(json({ operationId: operation.id }, 202))
        .mockResolvedValueOnce(json(operation));
      await wrapper!
        .get('button[aria-label="Delete My starter"]')
        .trigger("click");
      await flushPromises();
      expect(wrapper!.find('a[href="/configs/config-one"]').exists()).toBe(
        true,
      );
      expect(wrapper!.text()).toContain("Waiting for cleanup confirmation");
      fetchMock.mockResolvedValueOnce(
        json({ ...operation, status: "succeeded" }),
      );
      await vi.advanceTimersByTimeAsync(2000);
      expect(wrapper!.find('a[href="/configs/config-one"]').exists()).toBe(
        false,
      );
      const count = fetchMock.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60000);
      expect(fetchMock.mock.calls).toHaveLength(count);
    } finally {
      vi.useRealTimers();
    }
  });
  it("resumes a persisted deletion when the list is reopened without another DELETE", async () => {
    vi.useFakeTimers();
    try {
      const operation: RuntimeOperationResponse = {
        id: "delete-one",
        configId: config.id,
        revisionId: config.revision!.id,
        type: "delete",
        status: "running",
        stage: "deleting",
        error: null,
        cleanupPending: false,
        createdAt: "2026-11-02T00:00:00.000Z",
        completedAt: null,
      };
      fetchMock
        .mockResolvedValueOnce(json([{ ...config, deletion: operation }]))
        .mockResolvedValueOnce(json(operation));
      await open("/configs");
      expect(wrapper!.text()).toContain("Waiting for cleanup confirmation");
      expect(
        fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE"),
      ).toBe(false);
      fetchMock.mockResolvedValueOnce(
        json({ ...operation, status: "succeeded" }),
      );
      await vi.advanceTimersByTimeAsync(2000);
      expect(wrapper!.text()).toContain("No configurations yet");
    } finally {
      vi.useRealTimers();
    }
  });
});
