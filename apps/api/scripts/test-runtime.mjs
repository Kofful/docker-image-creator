/* global AbortSignal */
import "reflect-metadata";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { DockerRuntimeDriver } from "../dist/runtime/runtime.driver.js";
import { runtimeLabels } from "../dist/runtime/runtime.manifest.js";

import { runtimeFixture } from "../dist-test/test/runtime-fixtures.js";
import { composeIdentity } from "../dist/configs/compose.revision.js";

// Explicit opt-in, unique IDs, approved images, no repository env/config loading.
const executed = [];
class RecordingDriver extends DockerRuntimeDriver {
  async command(args, signal, input, ...rest) {
    if (args[0] === "compose") executed.push(input);
    return super.command(args, signal, input, ...rest);
  }
}
const driver = new RecordingDriver();
const targets = [];
const canary = createServer((socket) => socket.end("test-canary"));
function docker(args, timeout = 15000) {
  try {
    return execFileSync("docker", args, {
      encoding: "utf8",
      timeout,
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        DOCKER_HOST: "unix:///var/run/docker.sock",
      },
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new Error(
      "Disposable Docker check failed; command output is suppressed to protect credentials.",
    );
  }
}
function target(services) {
  const userId = randomUUID(),
    configId = randomUUID(),
    revisionId = randomUUID();
  let row = runtimeFixture(
    composeIdentity(userId, configId, revisionId),
    services,
  );
  if (services.some((service) => service.image === "node")) {
    const environment = row.requirements.environment;
    environment.push({
      reference: `DIC_SECRET_${randomBytes(16).toString("hex")}`,
      purpose: "Exact special characters",
      bindings: [{ service: "web", name: "APP_MESSAGE" }],
    });
    environment
      .find((entry) =>
        entry.bindings.some((binding) => binding.name === "MYSQL_PASSWORD"),
      )
      ?.bindings.push({ service: "web", name: "APP_PASSWORD" });
    row = runtimeFixture(row.requirements.identity, services, environment);
  }
  targets.push(row);
  return row;
}
function containers(row) {
  return docker([
    "ps",
    "--all",
    "--quiet",
    "--no-trunc",
    "--filter",
    `label=com.docker.compose.project=dic-${row.configId}`,
  ])
    .split(/\s+/)
    .filter(Boolean);
}
function verify(labels, row) {
  for (const [key, value] of Object.entries(
    runtimeLabels(row.userId, row.configId),
  ))
    assert.equal(
      labels[key],
      value,
      "Refusing cleanup of unowned test resources",
    );
}
function serviceId(row, name) {
  for (const id of containers(row)) {
    const labels = JSON.parse(
      docker(["inspect", "--format", "{{json .Config.Labels}}", id]),
    );
    verify(labels, row);
    if (labels["com.docker.compose.service"] === name) return id;
  }
  throw new Error("Test service missing");
}
try {
  const version = docker(["version", "--format", "{{.Server.Version}}"]);
  if (Number(version.split(".")[0]) < 28)
    throw new Error(
      `Runtime smoke test requires Docker Engine 28+. Found ${version}; no workloads were created.`,
    );
  await new Promise((resolve) => canary.listen(0, "0.0.0.0", resolve));
  const canaryPort = canary.address().port;
  const first = target([
    { name: "web", image: "node", type: "code" },
    { name: "db", image: "mysql", type: "database" },
  ]);
  const second = target([
    { name: "web", image: "python", type: "code" },
    { name: "db", image: "mongodb", type: "database" },
  ]);
  for (const row of targets) {
    console.log(
      `Starting ${row.services.map((service) => service.image).join("/")} fixture`,
    );
    try {
      await driver.start(row, AbortSignal.timeout(8 * 60000));
      console.log("Fixture ready");
    } catch (error) {
      const observed = await driver
        .observe(row, AbortSignal.timeout(15000))
        .catch(() => null);
      console.error(
        JSON.stringify({
          stage: "startup",
          services: observed?.services.map(({ name, state, health }) => ({
            name,
            state,
            health,
          })),
        }),
      );
      for (const id of containers(row)) {
        const inspection = JSON.parse(docker(["inspect", id]))[0];
        verify(inspection.Config.Labels, row);
        const logResult = spawnSync("docker", ["logs", id], {
          encoding: "utf8",
          timeout: 15000,
          env: {
            PATH: "/usr/local/bin:/usr/bin:/bin",
            DOCKER_HOST: "unix:///var/run/docker.sock",
          },
        });
        const logs = (logResult.stdout ?? "") + (logResult.stderr ?? "");
        const suppliedValuesExact = row.requirements.environment.every(
          (entry) =>
            entry.bindings
              .filter(
                (binding) =>
                  binding.service ===
                  inspection.Config.Labels["com.docker.compose.service"],
              )
              .every((binding) =>
                inspection.Config.Env.includes(
                  `${binding.name}=${row.secrets[entry.reference]}`,
                ),
              ),
        );
        console.error(JSON.stringify({ suppliedValuesExact }));
        const healthOutput =
          inspection.State.Health?.Log?.map((entry) => entry.Output).join(
            "\n",
          ) ?? "";
        console.error(
          JSON.stringify({
            healthFailureKinds: [
              "Authentication failed",
              "ECONNREFUSED",
              "Cannot read properties",
              "process is not defined",
              "not authorized",
              "MongoServerError",
              "not found",
              "pthread_create",
              "Resource temporarily unavailable",
              "MongoNetworkError",
              "Timeout",
            ].filter((message) => healthOutput.includes(message)),
            pidCount: inspection.State.Pid
              ? docker(["top", id, "-eo", "pid"]).split("\n").length - 1
              : 0,
          }),
        );
        console.error(
          JSON.stringify({
            mysqlErrorCodes: [
              ...new Set(logs.match(/MY-[0-9]{6}|ERROR [0-9]{4}/g) ?? []),
            ],
            oomKilled: inspection.State.OOMKilled,
            errorKinds: [
              "syntax",
              "Access denied",
              "Permission denied",
              "No space left",
              "Out of memory",
              "Unable to start server",
              "unknown variable",
            ].filter((message) => logs.includes(message)),
          }),
        );
        console.error(
          JSON.stringify({
            service: inspection.Config.Labels["com.docker.compose.service"],
            status: inspection.State.Status,
            exitCode: inspection.State.ExitCode,
            healthExitCodes: inspection.State.Health?.Log?.map(
              (entry) => entry.ExitCode,
            ),
          }),
        );
      }
      throw error;
    }
  }
  for (const row of targets)
    assert.equal(
      (await driver.observe(row, AbortSignal.timeout(15000))).ready,
      true,
    );
  const node = serviceId(first, "web");
  docker([
    "exec",
    node,
    "node",
    "-e",
    "fetch('http://127.0.0.1:8000').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
  ]);
  docker([
    "exec",
    node,
    "node",
    "-e",
    "const s=require('net').connect(3306,'db'); s.setTimeout(3000); s.on('connect',()=>{s.destroy();process.exit(0)}); s.on('error',()=>process.exit(1));s.on('timeout',()=>process.exit(1))",
  ]);
  const foreign = JSON.parse(
    docker([
      "inspect",
      "--format",
      "{{json .NetworkSettings.Networks}}",
      serviceId(second, "web"),
    ]),
  );
  const otherIP = Object.values(foreign)[0].IPAddress;
  const gateway = docker([
    "network",
    "inspect",
    "bridge",
    "--format",
    "{{(index .IPAM.Config 0).Gateway}}",
  ]);
  for (const [host, port] of [
    ["1.1.1.1", 80],
    [otherIP, 8000],
    [gateway, canaryPort],
  ])
    docker([
      "exec",
      node,
      "node",
      "-e",
      "const s=require('net').connect(Number(process.argv[2]),process.argv[1]); s.setTimeout(1500); s.on('connect',()=>{s.destroy();process.exit(1)}); s.on('error',()=>process.exit(0));s.on('timeout',()=>{s.destroy();process.exit(0)})",
      host,
      String(port),
    ]);
  for (const row of targets) {
    assert.equal(
      executed.filter((input) => input === row.manifest).length,
      2,
      "pull and up receive exactly the accepted document",
    );
  }
  // Verify supplied special characters survive Compose interpolation unchanged.
  const mysqlPassword = first.requirements.environment.find((entry) =>
    entry.bindings.some((binding) => binding.name === "MYSQL_PASSWORD"),
  );
  assert.ok(
    docker(["exec", serviceId(first, "db"), "printenv", "MYSQL_PASSWORD"]) ===
      first.secrets[mysqlPassword.reference].trim(),
    "Supplied-value comparison failed",
  );
  const terminalContainer = await driver.terminalContainer(first, "web");
  assert.equal(terminalContainer, node);
  assert.equal(
    docker(["exec", terminalContainer, "/bin/sh", "-c", "printf terminal-ok"]),
    "terminal-ok",
  );
  const message = first.requirements.environment.find((entry) =>
    entry.bindings.some((binding) => binding.name === "APP_MESSAGE"),
  );
  assert.ok(
    docker([
      "exec",
      node,
      "node",
      "-p",
      "JSON.stringify(process.env.APP_MESSAGE)",
    ]) === JSON.stringify(first.secrets[message.reference]),
    "Supplied-value comparison failed",
  );
  assert.ok(
    docker([
      "exec",
      node,
      "node",
      "-p",
      "JSON.stringify(process.env.APP_PASSWORD)",
    ]) === JSON.stringify(first.secrets[mysqlPassword.reference]),
    "Shared-value comparison failed",
  );
  const mysql = (sql) =>
    docker([
      "exec",
      "--env",
      `MYSQL_PWD=${first.secrets[first.requirements.environment.find((entry) => entry.bindings.some((binding) => binding.service === "db" && binding.name === "MYSQL_PASSWORD")).reference]}`,
      serviceId(first, "db"),
      "mysql",
      "--no-defaults",
      "--protocol=TCP",
      "-h",
      "127.0.0.1",
      "-u",
      "app",
      "app",
      "--batch",
      "--skip-column-names",
      "-e",
      sql,
    ]);
  mysql(
    "CREATE TABLE retained_data (id INT PRIMARY KEY); INSERT INTO retained_data VALUES (1)",
  );
  await driver.stop(first, AbortSignal.timeout(150000));
  assert.equal(
    (await driver.observe(first, AbortSignal.timeout(15000))).running,
    false,
  );
  await driver.start(first, AbortSignal.timeout(8 * 60000));
  assert.equal(mysql("SELECT COUNT(*) FROM retained_data"), "1");
  console.log(
    "Exact authored documents executed; supplied values and terminal authorization passed; all catalog images ready; same-configuration access, outbound/cross-configuration denial, and Stop/Start database retention passed.",
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Runtime smoke test failed",
  );
  process.exitCode = 1;
} finally {
  if (canary.listening) await new Promise((resolve) => canary.close(resolve));
  for (const row of targets) {
    try {
      for (const id of containers(row)) {
        verify(
          JSON.parse(
            docker(["inspect", "--format", "{{json .Config.Labels}}", id]),
          ),
          row,
        );
        docker(["rm", "--force", id], 40000);
      }
      const network = `dic-${row.configId}_stack`;
      if (
        docker(["network", "ls", "--quiet", "--filter", `name=^${network}$`])
      ) {
        verify(
          JSON.parse(
            docker([
              "network",
              "inspect",
              "--format",
              "{{json .Labels}}",
              network,
            ]),
          ),
          row,
        );
        docker(["network", "rm", network]);
      }
      for (const name of docker([
        "volume",
        "ls",
        "--quiet",
        "--filter",
        `label=docker-image-creator.config=${row.configId}`,
      ])
        .split(/\s+/)
        .filter(Boolean)) {
        verify(
          JSON.parse(
            docker(["volume", "inspect", "--format", "{{json .Labels}}", name]),
          ),
          row,
        );
        docker(["volume", "rm", name]);
      }
    } catch {
      console.error(
        "Disposable test resource cleanup needs a retry; unrelated resources were not touched.",
      );
      process.exitCode = 1;
    }
  }
}
