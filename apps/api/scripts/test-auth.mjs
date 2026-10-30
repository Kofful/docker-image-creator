import { execFileSync, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Always creates a disposable database; never reads env files or uses DATABASE_URL.
const name = `dic-auth-test-${randomUUID()}`;
const password = randomBytes(32).toString("hex");
const database = "auth_test";
let created = false;
let activeChild;
const artifacts = mkdtempSync(join(tmpdir(), "dic-config-tests-"));

function docker(args, timeout = 120000) {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout,
  }).trim();
}

function run(command, args, env, timeout = 120000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env, timeout });
    activeChild = child;
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      activeChild = undefined;
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${signal ?? code}`));
    });
  });
}

function cleanup() {
  if (!created) return;
  created = false;
  try {
    docker(["rm", "--force", "--volumes", name]);
  } catch {
    console.error(`Could not remove disposable test container ${name}`);
    process.exitCode = 1;
  }
}

for (const [signal, code] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  process.once(signal, () => {
    activeChild?.kill(signal);
    cleanup();
    process.exit(code);
  });
}

try {
  docker([
    "run",
    "--detach",
    "--rm",
    "--name",
    name,
    "--label",
    "docker-image-creator.test=auth",
    "--memory",
    "512m",
    "--cpus",
    "1",
    "--pids-limit",
    "256",
    "--publish",
    "127.0.0.1::3306",
    "--env",
    `MYSQL_ROOT_PASSWORD=${password}`,
    "--env",
    "MYSQL_ROOT_HOST=%",
    "--env",
    `MYSQL_DATABASE=${database}`,
    "mysql:8.4.11",
  ]);
  created = true;
  let ready = false;
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    try {
      docker(
        [
          "exec",
          "--env",
          `MYSQL_PWD=${password}`,
          name,
          "mysql",
          "--no-defaults",
          "--protocol=TCP",
          "-h",
          "127.0.0.1",
          "-u",
          "root",
          database,
          "-e",
          "SELECT 1",
        ],
        5000,
      );
      ready = true;
      break;
    } catch {
      await setTimeout(1000);
    }
  }
  if (!ready)
    throw new Error("Disposable MySQL was not ready within 90 seconds");
  const mapping = docker(["port", name, "3306/tcp"]);
  const port = mapping.match(/^127\.0\.0\.1:(\d+)$/)?.[1];
  if (!port) throw new Error("Could not resolve disposable MySQL port");
  const env = {
    ...process.env,
    NODE_ENV: "test",
    DATABASE_URL: `mysql://root:${password}@127.0.0.1:${port}/${database}`,
    AUTH_ACCESS_TOKEN_SECRET: randomBytes(48).toString("hex"),
    AUTH_TRUSTED_ORIGINS: "http://127.0.0.1:8080",
    AUTH_TEST_RUN: "1",
    CONFIG_ENCRYPTION_KEY: randomBytes(32).toString("hex"),
    CONFIG_ARTIFACT_ROOT: artifacts,
  };
  await run("pnpm", ["db:migrate"], env);
  // Applying the same committed migrations twice must be harmless.
  await run("pnpm", ["db:migrate"], env);
  await run(
    process.execPath,
    [
      "--test",
      "--test-concurrency=1",
      "dist-test/test/auth.test.js",
      "dist-test/test/configs.test.js",
    ],
    env,
    180000,
  );
} catch (error) {
  // Child-process errors may include command arguments; never print credentials.
  console.error(
    "Auth integration checks failed. Ensure Docker and the pinned MySQL image are available.",
  );
  if (error instanceof Error && !("stderr" in error))
    console.error(error.message);
  process.exitCode = 1;
} finally {
  cleanup();
  rmSync(artifacts, { recursive: true, force: true });
}
