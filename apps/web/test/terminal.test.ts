import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia } from "pinia";
import { createMemoryHistory } from "vue-router";
import type {
  ConfigResponse,
  TerminalEndReason,
} from "@docker-image-creator/contracts";
import App from "../src/App.vue";
import { createAppRouter } from "../src/router";
import { useAuthStore } from "../src/auth/store";
import { connectTerminal } from "../src/terminal/connection";
import { credentials, deferred, json, tokens } from "./helpers";

const terminals = vi.hoisted(() => ({
  instances: [] as {
    input?: (data: string) => void;
    resize?: (size: { cols: number; rows: number }) => void;
    write: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }[],
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    input?: (data: string) => void;
    resize?: (size: { cols: number; rows: number }) => void;
    write = vi.fn((_data: string, done: () => void) => done());
    dispose = vi.fn();
    parser = { registerOscHandler: vi.fn(), registerCsiHandler: vi.fn() };
    constructor() {
      terminals.instances.push(this);
    }
    loadAddon() {}
    open() {}
    focus() {}
    onData(callback: (data: string) => void) {
      this.input = callback;
    }
    onResize(callback: (size: { cols: number; rows: number }) => void) {
      this.resize = callback;
    }
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
  },
}));

class FakeSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: FakeSocket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  sent: string[] = [];
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (event: { data: unknown }) => void;
  constructor(readonly url: URL) {
    super();
    FakeSocket.instances.push(this);
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
    this.dispatchEvent(new Event("open"));
  }
  send(text: string) {
    this.sent.push(text);
  }
  message(value: object) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}
const ticket = {
  ticket: "a".repeat(43),
  socketPath: "/api/v1/terminal",
  expiresAt: "2026-11-03T00:00:30Z",
};
const config: ConfigResponse = {
  id: "config-one",
  name: "My configuration",
  description: "",
  services: [{ name: "web", image: "node", type: "code" }],
  generation: {
    id: "generation-one",
    configId: "config-one",
    status: "succeeded",
    stage: "complete",
    provider: "openrouter",
    inputVersion: 2,
    model: "google/gemma-4-26b-a4b-it:free",
    error: null,
    revisionId: "revision-one",
    createdAt: "2026-11-03T00:00:00Z",
    completedAt: "2026-11-03T00:00:01Z",
    runtimeValidation: "not_performed",
    cleanupPending: false,
  },
  revision: {
    id: "revision-one",
    version: 1,
    compose: "{}",
    digest: "digest",
    artifactPath: "private",
  },
};
let wrapper: VueWrapper | undefined;
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  terminals.instances = [];
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async (path) => {
    const url = String(path);
    if (url.endsWith("/auth/login")) return json(tokens());
    if (url.endsWith("/auth/logout"))
      return new Response(null, { status: 204 });
    if (url.endsWith("/terminal-tickets")) return json(ticket, 201);
    if (url.endsWith("/deployment"))
      return json({
        configId: config.id,
        revisionId: config.revision!.id,
        state: "running",
        operationId: "operation-one",
        observedAt: "2026-11-03T00:00:01Z",
      });
    if (url.endsWith("/operations/operation-one"))
      return json({
        id: "operation-one",
        configId: config.id,
        revisionId: config.revision!.id,
        type: "start",
        status: "succeeded",
        stage: "complete",
        error: null,
        cleanupPending: false,
        createdAt: "2026-11-03T00:00:00Z",
        completedAt: "2026-11-03T00:00:01Z",
      });
    if (url.endsWith("/services"))
      return json({
        configId: config.id,
        revisionId: config.revision!.id,
        operationId: "operation-one",
        services: [
          {
            name: "web",
            image: "node:22.23.4-bookworm-slim",
            state: "running",
            health: "healthy",
            publishedPort: null,
            observedAt: "2026-11-03T00:00:01Z",
          },
        ],
      });
    if (url.endsWith(`/configs/${config.id}`)) return json(config);
    throw new Error(`Unexpected request: ${url}`);
  });
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  vi.useRealTimers();
});

describe("terminal transport", () => {
  it("sends its ticket in the first message, streams output and resize/input, and does not reconnect", async () => {
    const view = {
      ready: vi.fn(),
      write: vi.fn((_data: string, done: () => void) => done()),
      ended: vi.fn(),
    };
    const connection = await connectTerminal(
      async () => json(ticket),
      "config-one",
      "web",
      view,
      new AbortController().signal,
    );
    const socket = FakeSocket.instances[0]!;
    expect(socket.url.search).toBe("");
    expect(socket.url.href).not.toContain(ticket.ticket);
    socket.open();
    expect(JSON.parse(socket.sent[0]!)).toEqual({ ticket: ticket.ticket });
    socket.message({ type: "ready", shell: "/bin/sh" });
    connection.send({ type: "resize", cols: 101, rows: 37 });
    connection.send({ type: "input", data: "pwd\n" });
    socket.message({ type: "output", data: "hello\r\n" });
    expect(view.write).toHaveBeenCalledWith("hello\r\n", expect.any(Function));
    expect(JSON.parse(socket.sent[1]!)).toEqual({
      type: "resize",
      cols: 101,
      rows: 37,
    });
    socket.close();
    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
    expect(view.ended).toHaveBeenCalledExactlyOnceWith("connection_lost");
    expect(FakeSocket.instances).toHaveLength(1);
  });
  it("has no terminal idle or duration timeout after connection", async () => {
    const view = { ready: vi.fn(), write: vi.fn(), ended: vi.fn() };
    await connectTerminal(
      async () => json(ticket),
      "config-one",
      "web",
      view,
      new AbortController().signal,
    );
    const socket = FakeSocket.instances[0]!;
    socket.open();
    socket.message({ type: "ready", shell: "/bin/bash" });
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(socket.readyState).toBe(FakeSocket.OPEN);
    expect(view.ended).not.toHaveBeenCalled();
  });
  it("does not open a socket after navigation cancels ticket issuance", async () => {
    const pending = deferred<Response>();
    const abort = new AbortController();
    const connecting = connectTerminal(
      () => pending.promise,
      "config-one",
      "web",
      { ready: vi.fn(), write: vi.fn(), ended: vi.fn() },
      abort.signal,
    );
    abort.abort();
    pending.resolve(json(ticket));
    await expect(connecting).rejects.toThrow();
    expect(FakeSocket.instances).toHaveLength(0);
  });
});

async function screen(path = "/configs/config-one/console/web") {
  const pinia = createPinia();
  const auth = useAuthStore(pinia);
  await auth.signIn("login", credentials);
  const router = createAppRouter(pinia, createMemoryHistory());
  await router.push(path);
  wrapper = mount(App, { global: { plugins: [pinia, router] } });
  await flushPromises();
  return { router, auth };
}
describe("terminal page", () => {
  it("Connect opens the selected service in the same tab and enables only running services", async () => {
    const { router } = await screen("/configs/config-one");
    const button = wrapper!.get('button[aria-label="Connect to web"]');
    expect(button.attributes("disabled")).toBeUndefined();
    await button.trigger("click");
    await vi.dynamicImportSettled();
    await flushPromises();
    expect(router.currentRoute.value.path).toBe(
      "/configs/config-one/console/web",
    );
    expect(wrapper!.text()).toContain("My configuration · web");
    expect(
      fetchMock.mock.calls.some(
        ([path, init]) =>
          String(path).endsWith("/terminal-tickets") &&
          new Headers(init?.headers).get("Authorization") ===
            "Bearer test-access-one",
      ),
    ).toBe(true);
  });
  it.each<TerminalEndReason>([
    "shell_exited",
    "shell_unavailable",
    "container_unavailable",
    "authorization_ended",
  ])("returns to config with an explanation after %s", async (reason) => {
    const { router } = await screen();
    const socket = FakeSocket.instances[0]!;
    socket.open();
    socket.message({ type: "ready", shell: "/bin/bash" });
    terminals.instances[0]!.input?.("pwd\n");
    expect(socket.sent.some((text) => JSON.parse(text).data === "pwd\n")).toBe(
      true,
    );
    socket.message({ type: "exit", reason });
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/configs/config-one");
    expect(router.currentRoute.value.query.terminal).toBe(reason);
    expect(terminals.instances[0]!.dispose).toHaveBeenCalledOnce();
  });
  it("Disconnect returns to config without sending Stop", async () => {
    const { router } = await screen();
    const socket = FakeSocket.instances[0]!;
    socket.open();
    socket.message({ type: "ready", shell: "/bin/sh" });
    await wrapper!.get("button").trigger("click");
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/configs/config-one");
    expect(socket.readyState).toBe(FakeSocket.CLOSED);
    expect(
      fetchMock.mock.calls.some(([path]) => String(path).endsWith("/stop")),
    ).toBe(false);
  });
  it("logout closes the terminal and returns to an unauthenticated config notice without fetching private data", async () => {
    const { router, auth } = await screen();
    const socket = FakeSocket.instances[0]!;
    socket.open();
    socket.message({ type: "ready", shell: "/bin/sh" });
    const count = fetchMock.mock.calls.filter(([path]) =>
      String(path).endsWith("/configs/config-one"),
    ).length;
    await auth.signOut();
    await flushPromises();
    expect(router.currentRoute.value.path).toBe("/configs/config-one");
    expect(wrapper!.text()).toContain("Log in to view this configuration");
    expect(
      fetchMock.mock.calls.filter(([path]) =>
        String(path).endsWith("/configs/config-one"),
      ),
    ).toHaveLength(count);
    expect(socket.readyState).toBe(FakeSocket.CLOSED);
  });
});
