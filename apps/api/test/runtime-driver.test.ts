import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import {
  DockerRuntimeDriver,
  RuntimeFailure,
  type RuntimeTarget,
} from "../src/runtime/runtime.driver";
import {
  runtimeLabels,
  runtimeManifest,
} from "../src/runtime/runtime.manifest";

function fixture() {
  const userId = randomUUID(),
    configId = randomUUID(),
    revisionId = randomUUID();
  const target: RuntimeTarget = {
    userId,
    configId,
    revisionId,
    services: [{ name: "web", image: "node", type: "code" }],
    secrets: {},
    manifest: "",
  };
  target.manifest = runtimeManifest(
    userId,
    configId,
    revisionId,
    target.services,
  );
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
    State: { Running: true, Restarting: false, Health: { Status: "healthy" } },
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
    protected override async command(args: string[]): Promise<string> {
      if (args[0] === "ps") return this.containerPresent ? container.Id : "";
      if (args[0] === "inspect") return JSON.stringify([container]);
      if (args[0] === "network" && args[1] === "ls")
        return this.networkPresent ? "b".repeat(64) : "";
      if (args[0] === "network" && args[1] === "inspect")
        return JSON.stringify([network]);
      this.mutations.push(args);
      if (args[0] === "stop") {
        container.State.Running = false;
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
  assert.deepEqual(
    await f.driver.observe(f.target, AbortSignal.timeout(1000)),
    { running: true, ready: true },
  );
  assert.deepEqual(f.driver.mutations, []);
});
test("Docker's CAP_NET_RAW spelling permits readiness and Stop", async () => {
  const f = fixture();
  // Engine inspect normalizes the manifest's NET_RAW to CAP_NET_RAW.
  f.container.HostConfig.CapDrop = ["CAP_NET_RAW"];
  assert.deepEqual(
    await f.driver.observe(f.target, AbortSignal.timeout(1000)),
    { running: true, ready: true },
  );
  await f.driver.stop(f.target, AbortSignal.timeout(1000));
  assert.deepEqual(f.driver.mutations, [
    ["stop", "--time", "30", f.container.Id],
  ]);
  assert.deepEqual(
    await f.driver.observe(f.target, AbortSignal.timeout(1000)),
    { running: false, ready: false },
  );
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
