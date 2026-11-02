import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const { AbortSignal, fetch, URL, WebSocket } = globalThis;

// Opt-in Docker check. Never loads env files or touches the application's stack.
const root = fileURLToPath(new URL("../../", import.meta.url));
const directory = await mkdtemp(path.join(tmpdir(), "dic-dev-test-"));
const project = `dic-dev-test-${randomUUID()}`;
const configFile = path.join(directory, "compose.json");
const env = {
  ...process.env,
  MYSQL_PASSWORD: randomBytes(24).toString("hex"),
  MYSQL_ROOT_PASSWORD: randomBytes(24).toString("hex"),
  MYSQL_DATABASE: "dev_test",
  MYSQL_USER: "dev_test",
  WEB_PORT: "0",
  AUTH_ACCESS_TOKEN_SECRET: randomBytes(48).toString("hex"),
  CONFIG_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
  AUTH_TRUSTED_ORIGINS: "http://127.0.0.1:8080",
  DEV_WATCH_POLLING: process.env.DEV_WATCH_POLLING ?? "false",
};
env.DATABASE_URL = `mysql://dev_test:${env.MYSQL_PASSWORD}@mysql:3306/dev_test`;
let created = false;
let socket;

function redact(value) {
  let output = String(value);
  for (const secret of [
    env.DATABASE_URL,
    env.MYSQL_PASSWORD,
    env.MYSQL_ROOT_PASSWORD,
    env.AUTH_ACCESS_TOKEN_SECRET,
    env.CONFIG_ENCRYPTION_KEY,
  ]) {
    output = output.replaceAll(secret, "<REDACTED>");
  }
  return output;
}

function docker(args, timeout = 120000) {
  return execFileSync("docker", args, {
    cwd: root,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  }).trim();
}

function compose(args, timeout) {
  return docker(
    [
      "compose",
      "--env-file",
      "/dev/null",
      "-p",
      project,
      "-f",
      configFile,
      ...args,
    ],
    timeout,
  );
}

async function waitFor(description, check, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await setTimeout(250);
  }
  throw new Error(`Timed out: ${description}`);
}

async function cleanup() {
  socket?.close();
  if (created) {
    compose(["down", "--volumes", "--remove-orphans", "--timeout", "10"]);
    created = false;
  }
  await rm(directory, { recursive: true, force: true });
}

for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(code));
  });
}

try {
  docker(
    [
      "build",
      "-f",
      "infra/Dockerfile.dev",
      "-t",
      "docker-image-creator-dev:local",
      ".",
    ],
    300000,
  );
  const config = JSON.parse(
    docker([
      "compose",
      "--env-file",
      "/dev/null",
      "-f",
      "infra/docker-compose.yml",
      "-f",
      "infra/docker-compose.dev.yml",
      "config",
      "--format",
      "json",
    ]),
  );
  config.name = project;
  // Compose's normalized output contains explicit resource names: isolate those too.
  config.volumes["mysql-data"].name = `${project}_mysql-data`;
  config.networks.infrastructure.name = `${project}_infrastructure`;
  assert.equal(config.services.web.ports.length, 1);
  assert.equal(config.services.web.ports[0].target, 5173);
  assert.equal(config.services.web.ports[0].host_ip, "127.0.0.1");
  assert.equal(config.services.api.ports, undefined);
  assert.equal(config.services.mysql.ports, undefined);

  const ids = {};
  for (const [service, settings] of Object.entries(config.services)) {
    delete settings.build;
    settings.labels = {
      ...settings.labels,
      "docker-image-creator.test": "dev",
    };
    settings.mem_limit = service === "mysql" ? "512m" : "1g";
    settings.cpus = 1;
    settings.pids_limit = 256;
    for (const volume of settings.volumes ?? []) {
      if (volume.type !== "bind" || !volume.target.endsWith("/src")) continue;
      const fixture = path.join(
        directory,
        service,
        path.relative("/app", volume.target),
      );
      await cp(volume.source, fixture, {
        recursive: true,
        filter: (source) => {
          const name = path.basename(source);
          return (
            name !== "generated" &&
            name !== ".env" &&
            !name.endsWith(".env") &&
            !name.startsWith(".env.")
          );
        },
      });
      volume.source = fixture;
    }
  }
  await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  created = true;
  // This reload check boots only web/API/MySQL; runtime has a separate smoke gate.
  compose(
    [
      "up",
      "-d",
      "--no-build",
      "--wait",
      "--wait-timeout",
      "150",
      "web",
      "api",
      "mysql",
    ],
    180000,
  );
  for (const service of ["web", "api", "mysql"])
    ids[service] = compose(["ps", "-q", service]);
  const address = compose(["port", "web", "5173"]);
  assert.match(address, /^127\.0\.0\.1:\d+$/);
  const origin = `http://${address}`;
  async function health() {
    try {
      const response = await fetch(`${origin}/api/v1/health`, {
        signal: AbortSignal.timeout(2000),
      });
      return response.ok ? await response.json() : null;
    } catch {
      return null;
    }
  }
  assert.deepEqual(await health(), { status: "ok", service: "api" });
  console.log(
    "PASS: development stack boot, migrations, and same-origin API proxy",
  );

  const appFile = path.join(directory, "web/apps/web/src/App.vue");
  await fetch(`${origin}/src/App.vue`); // Register the module in Vite's graph.
  let connected = false;
  let updated = false;
  socket = new WebSocket(origin.replace("http:", "ws:"), "vite-hmr");
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.type === "connected") connected = true;
    if (message.type === "update" || message.type === "full-reload")
      updated = true;
  });
  await waitFor("Vite HMR connection", () => connected);
  await writeFile(
    appFile,
    (await readFile(appFile, "utf8")).replace(
      "Docker Image Creator",
      "Live UI reload verified",
    ),
  );
  await waitFor("Vue hot update", () => updated);
  assert.match(
    await (await fetch(`${origin}/src/App.vue`)).text(),
    /Live UI reload verified/,
  );
  console.log(
    "PASS: Vue edit changes served content and sends a browser HMR update",
  );

  const controller = path.join(
    directory,
    "api/apps/api/src/health.controller.ts",
  );
  const original = await readFile(controller, "utf8");
  await writeFile(
    controller,
    original.replace(
      "service: 'api'",
      "service: 'api', ...{ devReload: 'updated' }",
    ),
  );
  await waitFor(
    "API recompilation and restart",
    async () => (await health())?.devReload === "updated",
  );
  await writeFile(controller, original.replace("status: 'ok'", "status: 123"));
  await waitFor("TypeScript rejects an invalid API edit", () =>
    compose(["logs", "--no-color", "api"]).includes("TS2322"),
  );
  assert.equal((await health())?.devReload, "updated");
  await writeFile(controller, original);
  await waitFor("API recovers after fixing the type error", async () => {
    const response = await health();
    return response?.status === "ok" && response.devReload === undefined;
  });
  console.log(
    "PASS: API reload, last valid build during a type error, and recovery",
  );

  for (const [requestOrigin, expected] of [
    ["https://untrusted.invalid", 403],
    [env.AUTH_TRUSTED_ORIGINS, 201],
  ]) {
    const response = await fetch(`${origin}/api/v1/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: requestOrigin },
      body: JSON.stringify({
        email: "dev-test@example.com",
        password: randomBytes(24).toString("hex"),
      }),
    });
    assert.equal(response.status, expected);
    await response.body?.cancel();
  }
  console.log("PASS: authentication through Vite retains origin protection");
  for (const [service, id] of Object.entries(ids))
    assert.equal(compose(["ps", "-q", service]), id);
  console.log("PASS: UI/API edits require no container rebuild or recreation");
  compose(["stop", "--timeout", "10", "api"]);
  const exitCode = docker([
    "inspect",
    "--format",
    "{{.State.ExitCode}}",
    ids.api,
  ]);
  assert.ok(
    ["0", "143"].includes(exitCode),
    "API watcher should stop without a forced container kill",
  );
  console.log("PASS: API watcher and child server shut down on container stop");
} catch (error) {
  console.error("Development smoke check failed.");
  if (error instanceof Error) {
    console.error(redact("stderr" in error ? error.stderr : error.message));
    if (created)
      console.error(
        redact(compose(["logs", "--no-color", "--tail", "30", "api", "web"])),
      );
  }
  process.exitCode = 1;
} finally {
  await cleanup();
}
