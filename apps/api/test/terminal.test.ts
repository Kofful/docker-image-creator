import "reflect-metadata";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { WebSocket } from "ws";
import type {
  AuthResponse,
  ConfigServiceInput,
  TerminalServerMessage,
  TerminalTicketResponse,
} from "@docker-image-creator/contracts";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/configure-app";
import { PrismaService } from "../src/database/prisma.service";
import { AuthService } from "../src/auth/auth.service";
import { compileCompose } from "../src/configs/compose.compiler";
import {
  digest,
  runtimeLabels,
  runtimeManifest,
} from "../src/runtime/runtime.manifest";
import {
  DockerRuntimeDriver,
  type RuntimeTarget,
} from "../src/runtime/runtime.driver";
import { TerminalService } from "../src/terminal/terminal.service";
import { TerminalRunner } from "../src/terminal/terminal.runner";
import { DockerExec } from "../src/terminal/docker-exec";
import { parseClientMessage } from "../src/terminal/terminal.protocol";

let app: INestApplication;
let prisma: PrismaService;
let auth: AuthResponse;
let terminal: TerminalService;
let runner: TerminalRunner;
let apiUrl: string;
let configId: string;
let revisionId: string;
let target: RuntimeTarget;
const clients: WebSocket[] = [];
const origin = "http://127.0.0.1:8080";

beforeEach(async () => {
  assert.equal(
    process.env.AUTH_TEST_RUN,
    "1",
    "Use the disposable MySQL harness",
  );
  const module = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  app = module.createNestApplication();
  configureApp(app);
  await app.listen(0, "127.0.0.1");
  apiUrl = (await app.getUrl()).replace("http:", "ws:");
  prisma = app.get(PrismaService);
  auth = await register();
  terminal = app.get(TerminalService);
  runner = new TerminalRunner(
    terminal,
    new DockerRuntimeDriver(),
    new DockerExec(),
  );
  const port = await runner.listen(0, "127.0.0.1");
  process.env.TERMINAL_RUNNER_URL = `ws://127.0.0.1:${port}/terminal`;
  configId = randomUUID();
  revisionId = randomUUID();
  const services: ConfigServiceInput[] = [
    { name: "web", type: "code", image: "node" },
  ];
  const generationId = randomUUID();
  await prisma.configuration.create({
    data: {
      id: configId,
      userId: auth.user.id,
      name: "Terminal test",
      description: "",
      services: [{ name: "web", type: "code", image: "node" }],
      requestKey: randomUUID(),
      inputDigest: "a".repeat(64),
      generations: {
        create: {
          id: generationId,
          status: "succeeded",
          inputEncrypted: "unused",
        },
      },
    },
  });
  const compose = compileCompose(configId, revisionId, services);
  await prisma.configRevision.create({
    data: {
      id: revisionId,
      configId,
      generationId,
      version: 1,
      compose,
      digest: digest(compose),
      artifactPath: "unused",
      spec: {
        schemaVersion: 1,
        catalogVersion: 1,
        services: [{ name: "web", type: "code", image: "node" }],
      },
    },
  });
  target = {
    userId: auth.user.id,
    configId,
    revisionId,
    services,
    manifest: runtimeManifest(auth.user.id, configId, revisionId, services),
    secrets: {},
  };
  await prisma.deployment.create({
    data: {
      configId,
      revisionId,
      operationId: randomUUID(),
      state: "running",
      manifest: target.manifest,
      digest: digest(target.manifest),
    },
  });
});
afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate();
  await runner?.onModuleDestroy();
  await app?.close();
  delete process.env.TERMINAL_RUNNER_URL;
});
async function register(): Promise<AuthResponse> {
  return (
    await request(app.getHttpServer())
      .post("/api/v1/auth/register")
      .send({
        email: `${randomUUID()}@example.com`,
        password: "a-long-test-password",
      })
      .expect(201)
  ).body as AuthResponse;
}
function issue(owner = auth, service = "web") {
  return request(app.getHttpServer())
    .post(`/api/v1/configs/${configId}/services/${service}/terminal-tickets`)
    .auth(owner.access_token, { type: "bearer" });
}
async function ticket() {
  return (await issue().expect(201)).body as TerminalTicketResponse;
}
function connect(value: TerminalTicketResponse, suppliedOrigin = origin) {
  const socket = new WebSocket(`${apiUrl}${value.socketPath}`, {
    origin: suppliedOrigin,
  });
  clients.push(socket);
  const messages: TerminalServerMessage[] = [];
  socket.on("error", () => undefined);
  socket.on("message", (data) =>
    messages.push(JSON.parse(data.toString()) as TerminalServerMessage),
  );
  socket.on("open", () =>
    socket.send(JSON.stringify({ ticket: value.ticket })),
  );
  return { socket, messages };
}
async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  ms = 15000,
) {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("Terminal test timed out");
    await delay(20);
  }
}
function docker(args: string[]) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    timeout: 20000,
    env: {
      PATH: "/usr/local/bin:/usr/bin:/bin",
      DOCKER_HOST: "unix:///var/run/docker.sock",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}
async function workload(run: (container: string) => Promise<void>) {
  const project = `dic-${configId}`,
    network = `${project}_stack`;
  const labels = {
    ...runtimeLabels(auth.user.id, configId),
    "com.docker.compose.project": project,
    "com.docker.compose.service": "web",
    "docker-image-creator.revision": revisionId,
    "docker-image-creator.test": "terminal",
  };
  const labelArgs = Object.entries(labels).flatMap(([key, value]) => [
    "--label",
    `${key}=${value}`,
  ]);
  let container = "",
    created = false;
  try {
    docker([
      "network",
      "create",
      "--internal",
      "--opt",
      "com.docker.network.bridge.gateway_mode_ipv4=isolated",
      ...labelArgs,
      network,
    ]);
    created = true;
    container = docker([
      "run",
      "-d",
      "--name",
      `${project}-web`,
      "--network",
      network,
      ...labelArgs,
      "--memory",
      "512m",
      "--cpus",
      "0.5",
      "--pids-limit",
      "128",
      "--cap-drop",
      "NET_RAW",
      "--restart",
      "no",
      "node:22.23.4-bookworm-slim",
      "node",
      "-e",
      "setInterval(()=>{},1000)",
    ]);
    await run(container);
  } finally {
    if (container) {
      const observed = JSON.parse(
        docker(["inspect", "--format", "{{json .Config.Labels}}", container]),
      ) as Record<string, string>;
      for (const [key, value] of Object.entries(labels))
        assert.equal(observed[key], value);
      docker(["rm", "-f", container]);
    }
    if (created) {
      const observed = JSON.parse(
        docker(["network", "inspect", "--format", "{{json .Labels}}", network]),
      ) as Record<string, string>;
      for (const [key, value] of Object.entries(labels))
        assert.equal(observed[key], value);
      docker(["network", "rm", network]);
    }
  }
}

test("terminal tickets enforce authentication, ownership, service, origin, payload and deployment identity", async () => {
  const other = await register();
  await issue(other).expect(404);
  await issue(auth, "missing").expect(404);
  await issue().set("Origin", "https://untrusted.example").expect(403);
  await issue().send({ command: "bash", privileged: true }).expect(400);
  await request(app.getHttpServer())
    .post(`/api/v1/configs/${configId}/services/web/terminal-tickets`)
    .expect(401);
  const accepted = await ticket();
  assert.match(accepted.ticket, /^[A-Za-z0-9_-]{43}$/);
  const row = await prisma.terminalTicket.findFirstOrThrow({
    where: { configId },
  });
  assert.notEqual(row.tokenHash, accepted.ticket);
  await prisma.deployment.update({
    where: { configId },
    data: { operationId: randomUUID() },
  });
  await assert.rejects(terminal.consume(accepted.ticket));
  await prisma.deployment.update({
    where: { configId },
    data: { state: "stopped" },
  });
  await issue().expect(409);
});
test("tickets are consumed atomically, expire, and reject session substitution/revocation", async () => {
  const accepted = await ticket();
  const attempts = await Promise.allSettled([
    terminal.consume(accepted.ticket),
    terminal.consume(accepted.ticket),
  ]);
  assert.equal(
    attempts.filter((item) => item.status === "fulfilled").length,
    1,
  );
  const expired = await ticket();
  await prisma.terminalTicket.updateMany({
    where: { configId, usedAt: null },
    data: { expiresAt: new Date(0) },
  });
  await assert.rejects(terminal.consume(expired.ticket));
  const revoked = await ticket();
  await app
    .get(AuthService)
    .logout(await app.get(AuthService).authenticate(auth.access_token));
  await assert.rejects(terminal.consume(revoked.ticket));
});
test("public WebSocket rejects missing/untrusted Origin and ticket URLs; client protocol rejects arbitrary commands and fields", async () => {
  const accepted = await ticket();
  for (const options of [
    { url: `${apiUrl}${accepted.socketPath}` },
    {
      url: `${apiUrl}${accepted.socketPath}`,
      origin: "https://untrusted.example",
    },
    {
      url: `${apiUrl}${accepted.socketPath}?ticket=${accepted.ticket}`,
      origin,
    },
  ]) {
    const socket = new WebSocket(options.url, { origin: options.origin });
    clients.push(socket);
    const status = await new Promise<number>((resolve, reject) => {
      socket.on("unexpected-response", (_req, response) => {
        response.resume();
        socket.terminate();
        resolve(response.statusCode!);
      });
      socket.on("error", () => undefined);
      setTimeout(() => reject(new Error("Upgrade timed out")), 1000).unref();
    });
    assert.equal(status, 403);
  }
  for (const message of [
    { type: "input", data: "x", userId: auth.user.id },
    { type: "exec", command: "bash" },
    { type: "resize", cols: -1, rows: 80 },
  ])
    assert.throws(() => parseClientMessage(JSON.stringify(message)));
});
test("real terminal streams shell input/output, resizes, exits, and never stops the main container", async () => {
  await workload(async (container) => {
    const { socket, messages } = connect(await ticket());
    await waitFor(() => messages.some((message) => message.type === "ready"));
    socket.send(JSON.stringify({ type: "resize", cols: 101, rows: 37 }));
    socket.send(
      JSON.stringify({
        type: "input",
        data: "printf 'terminal-%s\\n' works; stty size\n",
      }),
    );
    await waitFor(() =>
      messages.some(
        (message) =>
          message.type === "output" && message.data.includes("37 101"),
      ),
    );
    assert.ok(
      messages.some(
        (message) =>
          message.type === "output" && message.data.includes("terminal-works"),
      ),
    );
    socket.send(JSON.stringify({ type: "input", data: "exit\n" }));
    await waitFor(() =>
      messages.some(
        (message) =>
          message.type === "exit" && message.reason === "shell_exited",
      ),
    );
    const eof = connect(await ticket());
    await waitFor(() =>
      eof.messages.some((message) => message.type === "ready"),
    );
    eof.socket.send(JSON.stringify({ type: "input", data: "\u0004" }));
    await waitFor(() =>
      eof.messages.some(
        (message) =>
          message.type === "exit" && message.reason === "shell_exited",
      ),
    );
    assert.equal(
      docker(["inspect", "--format", "{{.State.Running}}", container]),
      "true",
    );
  });
});
test("real terminal disconnect cleans up its shell and foreground job; other terminals remain usable without a count quota", async () => {
  await workload(async (container) => {
    const engine = new DockerExec();
    const first = connect(await ticket());
    await waitFor(() =>
      first.messages.some((message) => message.type === "ready"),
    );
    const firstExec = (
      await engine.json<{ ExecIDs: string[] }>(`/containers/${container}/json`)
    ).ExecIDs[0]!;
    const second = connect(await ticket());
    await waitFor(() =>
      second.messages.some((message) => message.type === "ready"),
    );
    first.socket.send(JSON.stringify({ type: "input", data: "sleep 321\n" }));
    await delay(150);
    const inspect = await engine.json<{ ExecIDs: string[] }>(
      `/containers/${container}/json`,
    );
    const ids = inspect.ExecIDs;
    assert.ok(ids.length >= 2);
    const secondExec = ids.find((id) => id !== firstExec)!;
    first.socket.send(JSON.stringify({ type: "disconnect" }));
    await waitFor(() => first.socket.readyState === WebSocket.CLOSED);
    await waitFor(async () => !(await engine.running(firstExec, container)));
    await waitFor(
      () =>
        !docker(["top", container, "-eo", "pid,args"]).includes("sleep 321"),
    );
    second.socket.send(
      JSON.stringify({ type: "input", data: "printf 'second-%s\\n' alive\n" }),
    );
    await waitFor(() =>
      second.messages.some(
        (message) =>
          message.type === "output" && message.data.includes("second-alive"),
      ),
    );
    second.socket.terminate();
    await waitFor(async () => !(await engine.running(secondExec, container)));
    assert.equal(
      docker(["inspect", "--format", "{{.State.Running}}", container]),
      "true",
    );
  });
});
test("real terminal closes on logout and on container stop", async () => {
  await workload(async (container) => {
    const active = connect(await ticket());
    await waitFor(() =>
      active.messages.some((message) => message.type === "ready"),
    );
    await app
      .get(AuthService)
      .logout(await app.get(AuthService).authenticate(auth.access_token));
    await waitFor(() =>
      active.messages.some(
        (message) =>
          message.type === "exit" && message.reason === "authorization_ended",
      ),
    );
    auth = (
      await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({ email: auth.user.email, password: "a-long-test-password" })
        .expect(200)
    ).body as AuthResponse;
    const next = connect(await ticket());
    await waitFor(() =>
      next.messages.some((message) => message.type === "ready"),
    );
    docker(["stop", "--time", "1", container]);
    await waitFor(() =>
      next.messages.some((message) => message.type === "exit"),
    );
  });
});

test("real terminal falls back to sh and reports a shellless container without installing tools", async () => {
  await workload(async (container) => {
    docker([
      "exec",
      container,
      "node",
      "-e",
      "require('fs').renameSync('/bin/bash','/bin/bash.saved')",
    ]);
    const fallback = connect(await ticket());
    await waitFor(() =>
      fallback.messages.some(
        (message) => message.type === "ready" || message.type === "exit",
      ),
    );
    assert.ok(
      fallback.messages.some(
        (message) => message.type === "ready" && message.shell === "/bin/sh",
      ),
      JSON.stringify(
        fallback.messages.filter((message) => message.type !== "output"),
      ),
    );
    fallback.socket.send(JSON.stringify({ type: "input", data: "exit\n" }));
    await waitFor(() =>
      fallback.messages.some((message) => message.type === "exit"),
    );
    docker([
      "exec",
      container,
      "node",
      "-e",
      "require('fs').renameSync('/bin/sh','/bin/sh.saved')",
    ]);
    const shellless = connect(await ticket());
    await waitFor(() =>
      shellless.messages.some((message) => message.type === "exit"),
    );
    assert.ok(
      shellless.messages.some(
        (message) =>
          message.type === "exit" && message.reason === "shell_unavailable",
      ),
      JSON.stringify(shellless.messages),
    );
    assert.equal(
      docker(["inspect", "--format", "{{.State.Running}}", container]),
      "true",
    );
  });
});

test("real terminal closes when its authentication session expires or ownership changes", async () => {
  await workload(async () => {
    const session = await app.get(AuthService).authenticate(auth.access_token);
    const active = connect(await ticket());
    await waitFor(() =>
      active.messages.some((message) => message.type === "ready"),
    );
    await prisma.session.update({
      where: { id: session.sessionId },
      data: { expiresAt: new Date(0) },
    });
    await waitFor(() =>
      active.messages.some(
        (message) =>
          message.type === "exit" && message.reason === "authorization_ended",
      ),
    );
    auth = (
      await request(app.getHttpServer())
        .post("/api/v1/auth/login")
        .send({ email: auth.user.email, password: "a-long-test-password" })
        .expect(200)
    ).body as AuthResponse;
    const owned = connect(await ticket());
    await waitFor(() =>
      owned.messages.some((message) => message.type === "ready"),
    );
    const other = await register();
    await prisma.configuration.update({
      where: { id: configId },
      data: { userId: other.user.id },
    });
    await waitFor(() =>
      owned.messages.some((message) => message.type === "exit"),
    );
    // Restore fixture ownership so scoped test-resource cleanup can verify its original labels.
    await prisma.configuration.update({
      where: { id: configId },
      data: { userId: auth.user.id },
    });
  });
});
