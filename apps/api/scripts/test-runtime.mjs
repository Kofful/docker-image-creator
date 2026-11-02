/* global AbortSignal, fetch */
import "reflect-metadata";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { DockerRuntimeDriver } from "../dist/runtime/runtime.driver.js";
import {
  runtimeLabels,
  runtimeManifest,
} from "../dist/runtime/runtime.manifest.js";

// Explicit opt-in, unique IDs, approved images, no repository env/config loading.
const driver = new DockerRuntimeDriver();
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
  const secrets = {};
  for (const service of services)
    if (service.image === "mysql" || service.image === "mongodb") {
      const prefix = `DIC_${service.name.toUpperCase().replaceAll("-", "_")}`;
      secrets[`${prefix}_ROOT_PASSWORD`] =
        randomBytes(32).toString("base64url");
      if (service.image === "mysql")
        secrets[`${prefix}_PASSWORD`] = randomBytes(32).toString("base64url");
    }
  const row = {
    userId,
    configId,
    revisionId,
    services,
    secrets,
    manifest: runtimeManifest(userId, configId, revisionId, services),
  };
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
  const probe = createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const hostPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const first = target([
    { name: "web", image: "node", type: "code", hostPort },
    { name: "db", image: "mysql", type: "database" },
  ]);
  const second = target([
    { name: "web", image: "python", type: "code" },
    { name: "db", image: "mongodb", type: "database" },
  ]);
  for (const row of targets)
    await driver.start(row, AbortSignal.timeout(8 * 60000));
  for (const row of targets)
    assert.equal(
      (await driver.observe(row, AbortSignal.timeout(15000))).ready,
      true,
    );
  assert.equal(
    (
      await fetch(`http://127.0.0.1:${hostPort}`, {
        signal: AbortSignal.timeout(5000),
      })
    ).ok,
    true,
  );
  const node = serviceId(first, "web");
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
  const mysql = (sql) =>
    docker([
      "exec",
      "--env",
      `MYSQL_PWD=${first.secrets.DIC_DB_PASSWORD}`,
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
    "All catalog images ready; same-configuration access, outbound/cross-configuration denial, and Stop/Start database retention passed.",
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
