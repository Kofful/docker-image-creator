import "reflect-metadata";
import { runtimeFixture } from "./runtime-fixtures";
import { composeIdentity } from "../src/configs/compose.revision";
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import {
  DockerRuntimeDriver,
  RuntimeFailure,
} from "../src/runtime/runtime.driver";
import { runtimeLabels } from "../src/runtime/runtime.manifest";

function fixture() {
  const userId = randomUUID(),
    configId = randomUUID(),
    revisionId = randomUUID();
  const target = runtimeFixture(composeIdentity(userId, configId, revisionId), [
    { name: "web", image: "node", type: "code" },
  ]);
  const labels = runtimeLabels(userId, configId);
  const container = {
    Id: "a".repeat(64),
    Config: {
      Image: "node:22.23.4-bookworm-slim",
      Labels: {
        ...labels,
        "docker-image-creator.revision": revisionId,
        "com.docker.compose.service": "web",
      },
    },
    State: {
      Status: "running",
      Running: true,
      Restarting: false,
      Health: { Status: "healthy" },
    },
    NetworkSettings: { Networks: { [`dic-${configId}_stack`]: {} }, Ports: {} },
    HostConfig: {
      Privileged: false,
      NetworkMode: `dic-${configId}_stack`,
      Memory: 512 * 1024 * 1024,
      NanoCpus: 500000000,
      PidsLimit: 128,
      CapDrop: ["NET_RAW"],
      RestartPolicy: { Name: "no" },
    },
    Mounts: [] as { Type: string; Name: string; Destination: string }[],
  };
  const network = {
    Containers: {} as Record<string, unknown>,
    Internal: true,
    Driver: "bridge",
    EnableIPv6: false,
    Labels: labels,
    Options: { "com.docker.network.bridge.gateway_mode_ipv4": "isolated" },
  };
  class Driver extends DockerRuntimeDriver {
    mutations: string[][] = [];
    containerPresent = true;
    networkPresent = true;
    failNetworkRemoval = false;
    failInspection = false;
    protected override async command(args: string[]): Promise<string> {
      if (args[0] === "ps")
        return this.containerPresent
          ? args.includes("--format")
            ? `${container.Id}\tweb`
            : container.Id
          : "";
      if (args[0] === "inspect") {
        if (this.failInspection) throw new RuntimeFailure("DOCKER_UNAVAILABLE");
        return JSON.stringify([container]);
      }
      if (args[0] === "network" && args[1] === "ls")
        return this.networkPresent ? "b".repeat(64) : "";
      if (args[0] === "network" && args[1] === "inspect")
        return JSON.stringify([network]);
      this.mutations.push(args);
      if (args[0] === "stop") {
        container.State.Running = false;
        container.State.Status = "exited";
        return "";
      }
      if (args[0] === "rm") {
        assert.deepEqual(args, ["rm", container.Id]);
        assert.equal(container.State.Running, false);
        this.containerPresent = false;
        return "";
      }
      if (args[0] === "network" && args[1] === "rm") {
        if (this.failNetworkRemoval)
          throw new RuntimeFailure("DOCKER_UNAVAILABLE");
        this.networkPresent = false;
        return "";
      }
      throw new Error("Unexpected mutation");
    }
  }
  return { target, container, network, driver: new Driver() };
}
test("an owned, healthy deployment is observable without any mutation", async () => {
  const f = fixture();
  const observed = await f.driver.observe(f.target, AbortSignal.timeout(1000));
  assert.equal(observed.running, true);
  assert.equal(observed.ready, true);
  assert.equal(observed.services[0]?.state, "running");
  assert.equal(observed.services[0]?.image, "node:22.23.4-bookworm-slim");
  assert.equal(observed.services[0]?.health, "healthy");
  assert.deepEqual(f.driver.mutations, []);
});
test("Docker's CAP_NET_RAW spelling permits readiness and Stop", async () => {
  const f = fixture();
  // Engine inspect normalizes the manifest's NET_RAW to CAP_NET_RAW.
  f.container.HostConfig.CapDrop = ["CAP_NET_RAW"];
  assert.equal(
    (await f.driver.observe(f.target, AbortSignal.timeout(1000))).ready,
    true,
  );
  await f.driver.stop(f.target, AbortSignal.timeout(1000));
  assert.deepEqual(f.driver.mutations, [
    ["stop", "--time", "30", f.container.Id],
  ]);
  const stopped = await f.driver.observe(f.target, AbortSignal.timeout(1000));
  assert.equal(stopped.running, false);
  assert.equal(stopped.ready, false);
  assert.equal(stopped.services[0]?.state, "exited");
});

test("service summaries distinguish verified absence, exited, and unhealthy running containers", async () => {
  const f = fixture();
  f.driver.containerPresent = false;
  let observed = await f.driver.observe(f.target, AbortSignal.timeout(1000));
  assert.equal(observed.services[0]?.state, "not_created");
  assert.ok(observed.services[0]?.observedAt);
  assert.equal(observed.running, false);
  f.driver.containerPresent = true;
  f.container.State.Running = false;
  f.container.State.Status = "exited";
  observed = await f.driver.observe(f.target, AbortSignal.timeout(1000));
  assert.equal(observed.services[0]?.state, "exited");
  assert.equal(observed.running, false);
  f.container.State.Running = true;
  f.container.State.Status = "running";
  f.container.State.Health.Status = "unhealthy";
  observed = await f.driver.observe(f.target, AbortSignal.timeout(1000));
  assert.equal(observed.services[0]?.state, "running");
  assert.equal(observed.services[0]?.health, "unhealthy");
  assert.equal(observed.running, true);
  assert.equal(observed.ready, false);
});

test("an inspection failure is unknown, cannot prove stopped, and does not expose raw inspect fields", async () => {
  const f = fixture();
  Object.assign(f.container.Config, { Env: ["PASSWORD=private-value"] });
  const good = await f.driver.observe(f.target, AbortSignal.timeout(1000));
  assert.equal(good.services[0]?.publishedPort, null);
  assert.ok(!JSON.stringify(good).includes("private-value"));
  assert.ok(!JSON.stringify(good).includes(f.container.Id));
  f.driver.failInspection = true;
  const failed = await f.driver.observe(f.target, AbortSignal.timeout(1000));
  assert.equal(failed.running, undefined);
  assert.equal(failed.ready, false);
  assert.equal(failed.services[0]?.state, "unknown");
  assert.equal(failed.services[0]?.publishedPort, null);
  assert.equal(failed.services[0]?.observedAt, null);
});

test("one failed service inspection retains independently validated service results", async () => {
  const f = fixture();
  f.target.services.push({ name: "worker", image: "python", type: "code" });
  class PartialDriver extends DockerRuntimeDriver {
    protected override async command(args: string[]): Promise<string> {
      if (args[0] === "ps")
        return `${f.container.Id}\tweb\n${"c".repeat(64)}\tworker`;
      if (args[0] === "inspect") {
        if (args[1] !== f.container.Id)
          throw new RuntimeFailure("DOCKER_UNAVAILABLE");
        return JSON.stringify([f.container]);
      }
      if (args[1] === "ls") return "b".repeat(64);
      if (args[1] === "inspect") return JSON.stringify([f.network]);
      throw new Error("Unexpected command");
    }
  }
  const result = await new PartialDriver().observe(
    f.target,
    AbortSignal.timeout(1000),
  );
  assert.equal(result.services[0]?.state, "running");
  assert.equal(result.services[0]?.health, "healthy");
  assert.equal(result.services[1]?.state, "unknown");
  assert.equal(result.running, true);
  assert.equal(result.ready, false);
});
for (const mutation of [
  "owner",
  "revision",
  "privileged",
  "host-network",
  "mount",
  "resource-limit",
  "raw-sockets",
  "extra-network",
] as const) {
  test(`runner refuses to stop a container with conflicting ${mutation}`, async () => {
    const f = fixture();
    if (mutation === "owner")
      f.container.Config.Labels["docker-image-creator.user"] = randomUUID();
    if (mutation === "revision")
      f.container.Config.Labels["docker-image-creator.revision"] = randomUUID();
    if (mutation === "privileged") f.container.HostConfig.Privileged = true;
    if (mutation === "host-network")
      f.container.HostConfig.NetworkMode = "host";
    if (mutation === "mount")
      f.container.Mounts.push({
        Type: "bind",
        Name: "",
        Destination: "/var/run/docker.sock",
      });
    if (mutation === "resource-limit") f.container.HostConfig.Memory = 0;
    if (mutation === "raw-sockets") f.container.HostConfig.CapDrop = [];
    if (mutation === "extra-network")
      f.container.NetworkSettings.Networks.infrastructure = {};
    await assert.rejects(
      f.driver.stop(f.target, AbortSignal.timeout(1000)),
      (error: unknown) =>
        error instanceof RuntimeFailure && error.code === "RESOURCE_CONFLICT",
    );
    f.container.State.Running = false;
    await assert.rejects(
      f.driver.remove(f.target, AbortSignal.timeout(1000)),
      RuntimeFailure,
    );
    assert.deepEqual(f.driver.mutations, []);
  });
}
test("a network with disabled isolation or another owner is rejected", async () => {
  const f = fixture();
  f.network.Internal = false;
  await assert.rejects(
    f.driver.observe(f.target, AbortSignal.timeout(1000)),
    RuntimeFailure,
  );
  f.network.Internal = true;
  f.network.Labels["docker-image-creator.user"] = randomUUID();
  await assert.rejects(
    f.driver.observe(f.target, AbortSignal.timeout(1000)),
    RuntimeFailure,
  );
  assert.deepEqual(f.driver.mutations, []);
});

test("Delete removes only stopped containers and the owned network, preserves volumes, and is repeatable", async () => {
  const f = fixture();
  f.container.State.Running = false;
  await f.driver.remove(f.target, AbortSignal.timeout(1000));
  assert.deepEqual(f.driver.mutations, [
    ["rm", f.container.Id],
    ["network", "rm", "b".repeat(64)],
  ]);
  await f.driver.remove(f.target, AbortSignal.timeout(1000));
  assert.equal(f.driver.mutations.length, 2);
});
test("Delete refuses running or restarting services without mutations", async () => {
  for (const restarting of [false, true]) {
    const f = fixture();
    f.container.State.Running = !restarting;
    f.container.State.Restarting = restarting;
    await assert.rejects(
      f.driver.remove(f.target, AbortSignal.timeout(1000)),
      RuntimeFailure,
    );
    assert.deepEqual(f.driver.mutations, []);
  }
});
test("Delete validates network ownership and foreign attachments before removing any container", async () => {
  for (const foreignAttachment of [false, true]) {
    const f = fixture();
    f.container.State.Running = false;
    if (foreignAttachment) f.network.Containers["c".repeat(64)] = {};
    else f.network.Labels["docker-image-creator.user"] = randomUUID();
    await assert.rejects(
      f.driver.remove(f.target, AbortSignal.timeout(1000)),
      RuntimeFailure,
    );
    assert.deepEqual(f.driver.mutations, []);
  }
});
test("Delete resumes after partial removal and verifies the remaining network is absent", async () => {
  const f = fixture();
  f.container.State.Running = false;
  f.driver.failNetworkRemoval = true;
  await assert.rejects(
    f.driver.remove(f.target, AbortSignal.timeout(1000)),
    RuntimeFailure,
  );
  assert.equal(f.driver.containerPresent, false);
  assert.equal(f.driver.networkPresent, true);
  f.driver.failNetworkRemoval = false;
  await f.driver.remove(f.target, AbortSignal.timeout(1000));
  assert.equal(f.driver.networkPresent, false);
  assert.equal(f.driver.mutations.filter((args) => args[0] === "rm").length, 1);
});

test("Start revalidates bytes, metadata, identity and references before any Docker command", async () => {
  for (const tamper of [
    "digest",
    "yaml",
    "metadata",
    "scope",
    "legacy",
    "secret-key",
    "missing-secret",
  ] as const) {
    const target = runtimeFixture(
      composeIdentity(randomUUID(), randomUUID(), randomUUID()),
      [{ name: "db", type: "database", image: "mysql" }],
    );
    if (tamper === "digest") target.digest = "0".repeat(64);
    if (tamper === "yaml") target.manifest += "privileged: true\n";
    if (tamper === "metadata") target.metadata.services[0]!.volumes = [];
    if (tamper === "scope") target.configId = randomUUID();
    if (tamper === "legacy")
      Object.assign(target.metadata, { schemaVersion: 1 });
    if (tamper === "secret-key") target.secrets.PATH = "untrusted";
    if (tamper === "missing-secret") target.secrets = {};
    let calls = 0;
    class Driver extends DockerRuntimeDriver {
      protected override async command(): Promise<string> {
        calls++;
        throw new Error("Docker must not be called");
      }
    }
    await assert.rejects(
      new Driver().start(target, AbortSignal.timeout(1000)),
      (error: unknown) =>
        error instanceof RuntimeFailure && error.code === "INVALID_REVISION",
    );
    assert.equal(calls, 0, tamper);
  }
});

test("pull and up receive original authored bytes and only explicit opaque values", async () => {
  const target = runtimeFixture(
    composeIdentity(randomUUID(), randomUUID(), randomUUID()),
    [{ name: "web", type: "code", image: "node" }],
  );
  const calls: {
    args: string[];
    input?: string;
    secrets?: Record<string, string>;
  }[] = [];
  class Driver extends DockerRuntimeDriver {
    protected override async command(
      args: string[],
      _signal: AbortSignal,
      input?: string,
      secrets?: Record<string, string>,
    ): Promise<string> {
      calls.push({ args, input, secrets });
      if (args[0] === "info")
        return JSON.stringify({
          ServerVersion: "28.1.1",
          OSType: "linux",
          MemoryLimit: true,
          PidsLimit: true,
          CpuCfsQuota: true,
        });
      return "";
    }
    override async observe() {
      return { running: true, ready: true, services: [] };
    }
  }
  await new Driver().start(target, AbortSignal.timeout(1000));
  const compose = calls.filter((call) => call.args[0] === "compose");
  assert.equal(compose.length, 2);
  for (const call of compose) {
    assert.equal(call.input, target.manifest);
    assert.deepEqual(call.secrets, target.secrets);
    assert.ok(call.args.includes("/dev/null"));
    assert.equal(call.args.at(call.args.indexOf("--file") + 1), "-");
  }
});
