import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia } from "pinia";
import { createMemoryHistory } from "vue-router";
import type {
  ConfigResponse,
  DeploymentResponse,
  RuntimeOperationResponse,
} from "@docker-image-creator/contracts";
import App from "../src/App.vue";
import { createAppRouter } from "../src/router";
import { useAuthStore } from "../src/auth/store";
import { credentials, deferred, json, tokens } from "./helpers";

const config: ConfigResponse = {
  id: "config-one",
  name: "My starter",
  description: "",
  services: [],
  generation: {
    id: "generation-one",
    configId: "config-one",
    status: "succeeded",
    stage: "complete",
    provider: "fake",
    error: null,
    revisionId: "revision-one",
    createdAt: "2026-11-02T00:00:00.000Z",
    completedAt: "2026-11-02T00:00:01.000Z",
    runtimeValidation: "not_performed",
    cleanupPending: false,
  },
  revision: {
    id: "revision-one",
    version: 1,
    compose: '{"services":{}}',
    digest: "digest",
    artifactPath: "private/compose.yaml",
  },
};

describe("configuration runtime controls", () => {
  let wrapper: VueWrapper | undefined;
  let deployment: DeploymentResponse | null;
  let operation: RuntimeOperationResponse;
  const fetchMock = vi.fn<typeof fetch>();

  function setDeployment(state: DeploymentResponse["state"]) {
    deployment = {
      configId: config.id,
      revisionId: config.revision!.id,
      state,
      operationId: operation.id,
      observedAt: "2026-11-02T00:00:02.000Z",
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    deployment = null;
    operation = {
      id: "operation-one",
      configId: config.id,
      revisionId: config.revision!.id,
      type: "start",
      status: "succeeded",
      stage: "complete",
      error: null,
      cleanupPending: false,
      createdAt: "2026-11-02T00:00:01.000Z",
      completedAt: "2026-11-02T00:00:02.000Z",
    };
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (path) => {
      if (path === "/api/v1/auth/login") return json(tokens());
      if (path === "/api/v1/configs/config-one") return json(config);
      if (path === "/api/v1/configs/config-one/deployment")
        return deployment ? json(deployment) : json({}, 404);
      if (
        path === "/api/v1/operations/operation-one" ||
        path === "/api/v1/operations/operation-two"
      )
        return json(operation);
      if (path === "/api/v1/configs") return json([config]);
      throw new Error(`Unexpected request: ${String(path)}`);
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    vi.useRealTimers();
  });

  async function open() {
    const pinia = createPinia();
    await useAuthStore(pinia).signIn("login", credentials);
    const router = createAppRouter(pinia, createMemoryHistory());
    await router.push(`/configs/${config.id}`);
    await router.isReady();
    wrapper = mount(App, { global: { plugins: [pinia, router] } });
    await flushPromises();
    return router;
  }

  function actionButton() {
    return wrapper!.get(".config-actions > button");
  }
  function deleteButton() {
    return wrapper!.get('button[aria-label="Delete My starter"]');
  }
  function posts() {
    return fetchMock.mock.calls.filter(
      ([, init]) =>
        init?.method === "POST" &&
        String(init.body) !== JSON.stringify(credentials),
    );
  }

  it("shows an enabled Start to the left of Delete for a never-started config", async () => {
    await open();
    expect(wrapper!.get(".runtime-status").text()).toBe("Not started");
    expect(wrapper!.text()).not.toContain("Generation:");
    expect(actionButton().text()).toBe("Start");
    expect(actionButton().attributes("disabled")).toBeUndefined();
    expect(deleteButton().attributes("disabled")).toBeUndefined();
    expect(
      wrapper!
        .get(".config-actions")
        .findAll("button")
        .map((b) => b.text()),
    ).toEqual(["Start", "Delete"]);
    expect(posts()).toHaveLength(0);
  });

  it("waits for the first runtime check before enabling Start or Delete", async () => {
    const status = deferred<Response>();
    fetchMock
      .mockResolvedValueOnce(json(tokens()))
      .mockResolvedValueOnce(json(config))
      .mockReturnValueOnce(status.promise);
    await open();
    expect(actionButton().attributes("disabled")).toBeDefined();
    expect(deleteButton().attributes("disabled")).toBeDefined();
    status.resolve(json({}, 404));
    await flushPromises();
    expect(actionButton().attributes("disabled")).toBeUndefined();
    expect(deleteButton().attributes("disabled")).toBeUndefined();
  });

  it.each([
    ["starting", "Starting", "Starting…", true],
    ["running", "Running", "Stop", false],
    ["stopping", "Stopping", "Stopping…", true],
    ["stopped", "Stopped", "Start", false],
    ["failed", "Failed", "Stop", false],
    ["unknown", "Unknown", "Stop", false],
  ] as const)(
    "renders %s with only the appropriate action and deletion blocked",
    async (state, label, button, disabled) => {
      setDeployment(state);
      await open();
      expect(wrapper!.get(".runtime-status").text()).toBe(label);
      expect(actionButton().text()).toBe(button);
      expect(actionButton().attributes("disabled") !== undefined).toBe(
        disabled,
      );
      expect(wrapper!.get(".config-actions").findAll("button")).toHaveLength(2);
      expect(deleteButton().attributes("disabled")).toBeDefined();
      expect(wrapper!.text()).toContain("even after Stop");
      await deleteButton().trigger("click");
      expect(
        fetchMock.mock.calls.some(([, init]) => init?.method === "DELETE"),
      ).toBe(false);
    },
  );

  it("uses authenticated explicit Start/Stop, guards duplicates, and follows operations to completion", async () => {
    await open();
    const start = deferred<Response>();
    fetchMock.mockReturnValueOnce(start.promise);
    await actionButton().trigger("click");
    expect(actionButton().text()).toBe("Starting…");
    expect(actionButton().attributes("disabled")).toBeDefined();
    expect(deleteButton().attributes("disabled")).toBeDefined();
    await actionButton().trigger("click");
    expect(posts()).toHaveLength(1);
    expect(posts()[0]?.[0]).toBe("/api/v1/configs/config-one/start");
    expect(JSON.parse(String(posts()[0]?.[1]?.body))).toEqual({
      revisionId: "revision-one",
    });
    const headers = new Headers(posts()[0]?.[1]?.headers);
    expect(headers.get("Authorization")).toMatch(/^Bearer /);
    expect(headers.get("Idempotency-Key")).toMatch(/^[0-9a-f-]{36}$/);
    operation = {
      ...operation,
      status: "queued",
      stage: "queued",
      completedAt: null,
    };
    setDeployment("starting");
    start.resolve(
      json(
        {
          operationId: operation.id,
          statusUrl: "/api/v1/operations/operation-one",
          pollAfterMs: 2000,
        },
        202,
      ),
    );
    await flushPromises();
    expect(actionButton().text()).toBe("Starting…");
    expect(wrapper!.text()).toContain("Runtime operation: queued");
    operation = { ...operation, status: "succeeded", stage: "complete" };
    setDeployment("running");
    await vi.advanceTimersByTimeAsync(2000);
    expect(wrapper!.get(".runtime-status").text()).toBe("Running");
    expect(actionButton().text()).toBe("Stop");
    const afterStart = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30000);
    expect(fetchMock.mock.calls).toHaveLength(afterStart);

    operation = {
      ...operation,
      id: "operation-two",
      type: "stop",
      status: "running",
      stage: "stopping",
    };
    setDeployment("stopping");
    fetchMock.mockResolvedValueOnce(
      json(
        {
          operationId: operation.id,
          statusUrl: "/api/v1/operations/operation-two",
          pollAfterMs: 2000,
        },
        202,
      ),
    );
    await actionButton().trigger("click");
    await flushPromises();
    expect(actionButton().text()).toBe("Stopping…");
    expect(posts()[1]?.[0]).toBe("/api/v1/configs/config-one/stop");
    expect(JSON.parse(String(posts()[1]?.[1]?.body))).toEqual({});
    expect(
      new Headers(posts()[1]?.[1]?.headers).get("Idempotency-Key"),
    ).not.toBe(headers.get("Idempotency-Key"));
    operation = { ...operation, status: "succeeded", stage: "complete" };
    setDeployment("stopped");
    await vi.advanceTimersByTimeAsync(2000);
    expect(wrapper!.get(".runtime-status").text()).toBe("Stopped");
    expect(actionButton().text()).toBe("Start");
    expect(deleteButton().attributes("disabled")).toBeDefined();
    const afterStop = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30000);
    expect(fetchMock.mock.calls).toHaveLength(afterStop);
  });

  it.each([null, "running", "stopped", "failed", "unknown"] as const)(
    "stops fetching after the initial settled status check: %s",
    async (state) => {
      if (state) setDeployment(state);
      await open();
      const count = fetchMock.mock.calls.length;
      setDeployment("starting");
      await vi.advanceTimersByTimeAsync(60000);
      expect(fetchMock.mock.calls).toHaveLength(count);
      expect(wrapper!.get(".runtime-status").attributes("data-state")).toBe(
        state ?? "not_started",
      );
      expect(posts()).toHaveLength(0);
    },
  );

  it.each([
    ["starting", "start", "running"],
    ["stopping", "stop", "stopped"],
  ] as const)(
    "resumes an existing %s operation on page load and stops at completion",
    async (initial, type, final) => {
      operation = { ...operation, type, status: "running" };
      setDeployment(initial);
      await open();
      operation = { ...operation, status: "succeeded" };
      setDeployment(final);
      await vi.advanceTimersByTimeAsync(2000);
      expect(wrapper!.get(".runtime-status").attributes("data-state")).toBe(
        final,
      );
      const count = fetchMock.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60000);
      expect(fetchMock.mock.calls).toHaveLength(count);
    },
  );

  it("retains failed-start errors when rollback reports stopped, and uses a fresh key for an explicit new attempt", async () => {
    await open();
    operation = {
      ...operation,
      status: "failed",
      stage: "failed",
      error: {
        code: "START_FAILED",
        message: "Services could not reach readiness. Data has been preserved.",
      },
    };
    setDeployment("stopped");
    fetchMock.mockResolvedValueOnce(
      json({ operationId: operation.id, pollAfterMs: 2000 }, 202),
    );
    await actionButton().trigger("click");
    await flushPromises();
    expect(wrapper!.get(".runtime-status").text()).toBe("Stopped");
    expect(wrapper!.text()).toContain("Services could not reach readiness");
    expect(actionButton().text()).toBe("Start");
    operation = {
      ...operation,
      id: "operation-two",
      status: "queued",
      stage: "queued",
      error: null,
    };
    setDeployment("starting");
    fetchMock.mockResolvedValueOnce(
      json({ operationId: "operation-two", pollAfterMs: 2000 }, 202),
    );
    await actionButton().trigger("click");
    expect(
      new Headers(posts()[0]?.[1]?.headers).get("Idempotency-Key"),
    ).not.toBe(new Headers(posts()[1]?.[1]?.headers).get("Idempotency-Key"));
    await flushPromises();
    expect(actionButton().text()).toBe("Starting…");
    expect(wrapper!.text()).not.toContain("Services could not reach readiness");
  });

  it("follows a newer operation from another tab after the submitted one completes", async () => {
    await open();
    const submitted = { ...operation };
    operation = {
      ...operation,
      id: "operation-two",
      type: "stop",
      status: "running",
      stage: "stopping",
    };
    setDeployment("stopping");
    fetchMock
      .mockResolvedValueOnce(
        json({ operationId: submitted.id, pollAfterMs: 2000 }, 202),
      )
      .mockResolvedValueOnce(json(deployment))
      .mockResolvedValueOnce(json(operation))
      .mockResolvedValueOnce(json(submitted));
    await actionButton().trigger("click");
    await flushPromises();
    expect(actionButton().text()).toBe("Stopping…");
    expect(wrapper!.text()).not.toContain("Could not check runtime status");
    operation = { ...operation, status: "succeeded", stage: "complete" };
    setDeployment("stopped");
    await vi.advanceTimersByTimeAsync(2000);
    expect(actionButton().text()).toBe("Start");
  });

  it("shows cleanup failures with Stop recovery and offers Start after verified stop", async () => {
    operation = {
      ...operation,
      status: "failed",
      cleanupPending: true,
      error: {
        code: "STOP_FAILED",
        message: "Services could not be verified stopped. Retry Stop.",
      },
    };
    setDeployment("unknown");
    await open();
    expect(actionButton().text()).toBe("Stop");
    expect(wrapper!.text()).toContain("Some resources may still be running");
    expect(wrapper!.text()).toContain("Retry Stop");
    fetchMock.mockResolvedValueOnce(
      json({ operationId: operation.id, pollAfterMs: 2000 }, 202),
    );
    operation = { ...operation, cleanupPending: false };
    setDeployment("stopped");
    await actionButton().trigger("click");
    await flushPromises();
    expect(actionButton().text()).toBe("Start");
    expect(wrapper!.text()).not.toContain(
      "Some resources may still be running",
    );
  });

  it("reuses the key after a lost response without automatically replaying Start", async () => {
    await open();
    fetchMock.mockRejectedValueOnce(new TypeError("lost response"));
    await actionButton().trigger("click");
    await flushPromises();
    expect(wrapper!.text()).toContain("Could not confirm Start");
    expect(actionButton().attributes("disabled")).toBeUndefined();
    expect(deleteButton().attributes("disabled")).toBeDefined();
    await vi.advanceTimersByTimeAsync(6000);
    expect(posts()).toHaveLength(1);
    operation = { ...operation, status: "queued", stage: "queued" };
    setDeployment("starting");
    fetchMock.mockResolvedValueOnce(
      json({ operationId: operation.id, pollAfterMs: 2000 }, 202),
    );
    await actionButton().trigger("click");
    await flushPromises();
    expect(posts()).toHaveLength(2);
    expect(new Headers(posts()[0]?.[1]?.headers).get("Idempotency-Key")).toBe(
      new Headers(posts()[1]?.[1]?.headers).get("Idempotency-Key"),
    );
    expect(actionButton().text()).toBe("Starting…");
    expect(wrapper!.text()).not.toContain("Could not confirm Start");
  });

  it("discovers an accepted Start after a lost response through status polling", async () => {
    await open();
    fetchMock.mockRejectedValueOnce(new TypeError("lost response"));
    await actionButton().trigger("click");
    await flushPromises();
    setDeployment("running");
    await vi.advanceTimersByTimeAsync(2000);
    expect(actionButton().text()).toBe("Stop");
    expect(wrapper!.text()).not.toContain("Could not confirm Start");
    expect(posts()).toHaveLength(1);
  });

  it("shows admission conflicts without inventing a running deployment or blocking deletion", async () => {
    await open();
    fetchMock.mockResolvedValueOnce(json({}, 409));
    await actionButton().trigger("click");
    await flushPromises();
    expect(wrapper!.text()).toContain(
      "only one configuration can run per account",
    );
    expect(wrapper!.get(".runtime-status").text()).toBe("Not started");
    expect(actionButton().attributes("disabled")).toBeUndefined();
    expect(deleteButton().attributes("disabled")).toBeUndefined();
  });

  it("retries an initial status failure and stops fetching after recovery", async () => {
    setDeployment("running");
    fetchMock
      .mockResolvedValueOnce(json(tokens()))
      .mockResolvedValueOnce(json(config))
      .mockRejectedValueOnce(new TypeError("offline"));
    await open();
    expect(wrapper!.get(".runtime-status").text()).toBe("Unknown");
    expect(wrapper!.text()).toContain("Could not check runtime status");
    expect(actionButton().attributes("disabled")).toBeDefined();
    await vi.advanceTimersByTimeAsync(4000);
    expect(wrapper!.get(".runtime-status").text()).toBe("Running");
    expect(actionButton().attributes("disabled")).toBeUndefined();
    const count = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetchMock.mock.calls).toHaveLength(count);
  });

  it("recovers from an in-progress polling failure and stops after completion", async () => {
    operation = { ...operation, status: "running" };
    setDeployment("starting");
    await open();
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    await vi.advanceTimersByTimeAsync(2000);
    expect(wrapper!.get(".runtime-status").text()).toBe("Unknown");
    expect(actionButton().attributes("disabled")).toBeDefined();
    operation = { ...operation, status: "succeeded" };
    setDeployment("running");
    await vi.advanceTimersByTimeAsync(4000);
    expect(wrapper!.get(".runtime-status").text()).toBe("Running");
    const count = fetchMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(fetchMock.mock.calls).toHaveLength(count);
  });

  it("keeps Start disabled while generation runs and preserves generation errors", async () => {
    const generated = deferred<Response>();
    fetchMock.mockResolvedValueOnce(json(tokens()));
    fetchMock.mockResolvedValueOnce(
      json({
        ...config,
        revision: null,
        generation: {
          ...config.generation,
          status: "running",
          stage: "generating",
        },
      }),
    );
    fetchMock.mockImplementationOnce(async () => json({}, 404));
    fetchMock.mockReturnValueOnce(generated.promise);
    await open();
    expect(actionButton().attributes("disabled")).toBeDefined();
    expect(wrapper!.text()).toContain("Generating Compose: generating");
    expect(wrapper!.text()).toContain("Generation can take several minutes");
    generated.resolve(
      json({
        ...config.generation,
        status: "failed",
        stage: "failed",
        error: {
          code: "GENERATION_FAILED",
          message: "Generation failed. Try again.",
        },
      }),
    );
    await flushPromises();
    expect(wrapper!.get(".runtime-status").text()).toBe("Not started");
    expect(actionButton().text()).toBe("Start");
    expect(actionButton().attributes("disabled")).toBeDefined();
    expect(wrapper!.text()).toContain("Generation failed. Try again.");
    expect(posts()).toHaveLength(0);
  });

  it("blocks Start during deletion and cancels runtime polling on navigation", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const router = await open();
    const deletion = deferred<Response>();
    fetchMock.mockReturnValueOnce(deletion.promise);
    await deleteButton().trigger("click");
    expect(actionButton().attributes("disabled")).toBeDefined();
    deletion.resolve(json({}, 500));
    await flushPromises();
    expect(actionButton().attributes("disabled")).toBeUndefined();
    operation = { ...operation, status: "running" };
    setDeployment("starting");
    fetchMock.mockResolvedValueOnce(
      json({ operationId: operation.id, pollAfterMs: 2000 }, 202),
    );
    await actionButton().trigger("click");
    await flushPromises();
    expect(actionButton().text()).toBe("Starting…");
    const runtimeRequests = () =>
      fetchMock.mock.calls.filter(([path]) =>
        String(path).includes("/deployment"),
      ).length;
    const count = runtimeRequests();
    const signal = fetchMock.mock.calls.find(([path]) =>
      String(path).includes("/deployment"),
    )?.[1]?.signal;
    await router.push("/configs");
    await flushPromises();
    expect(signal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(60000);
    expect(runtimeRequests()).toBe(count);
  });

  it("aborts a pending Start on navigation and ignores its late response", async () => {
    const router = await open();
    const start = deferred<Response>();
    fetchMock.mockReturnValueOnce(start.promise);
    await actionButton().trigger("click");
    const signal = posts()[0]?.[1]?.signal;
    await router.push("/configs");
    await flushPromises();
    expect(signal?.aborted).toBe(true);
    const count = fetchMock.mock.calls.length;
    start.resolve(json({ operationId: operation.id, pollAfterMs: 2000 }, 202));
    await flushPromises();
    await vi.advanceTimersByTimeAsync(10000);
    expect(fetchMock.mock.calls).toHaveLength(count);
    expect(wrapper!.find(".runtime-status").exists()).toBe(false);
  });
});
