import "reflect-metadata";
import assert from "node:assert/strict";
import { beforeEach, afterEach, test } from "node:test";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import type {
  AuthResponse,
  ConfigResponse,
  CreateConfigResponse,
  RuntimeAcceptedResponse,
  RuntimeOperationResponse,
} from "@docker-image-creator/contracts";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/configure-app";
import { PrismaService } from "../src/database/prisma.service";
import { GenerationSettings } from "../src/configs/generation.settings";
import { GenerationWorker } from "../src/configs/generation.worker";
import { ArtifactStore } from "../src/configs/artifact.store";
import { SecretBox } from "../src/configs/secret-box";
import {
  DockerRuntimeDriver,
  RuntimeDriver,
  RuntimeFailure,
  type RuntimeTarget,
} from "../src/runtime/runtime.driver";
import { RuntimeSettings, RuntimeWorker } from "../src/runtime/runtime.worker";
import {
  digest,
  revisionServices,
  runtimeManifest,
} from "../src/runtime/runtime.manifest";

class ControlledDriver extends RuntimeDriver {
  states = new Map<string, { running: boolean; ready: boolean }>();
  targets: RuntimeTarget[] = [];
  failStart = false;
  failStop = false;
  failDelete = false;
  removed: string[] = [];
  async remove(target: RuntimeTarget, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.failDelete || this.states.get(target.configId)?.running) throw new RuntimeFailure("DELETE_FAILED");
    this.removed.push(target.configId);
    this.states.delete(target.configId);
  }
  unavailable = false;
  async start(target: RuntimeTarget, signal: AbortSignal) {
    signal.throwIfAborted();
    this.targets.push({ ...target });
    this.states.set(target.configId, { running: true, ready: !this.failStart });
    if (this.failStart) throw new RuntimeFailure("START_FAILED");
  }
  async stop(target: RuntimeTarget, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.failStop) throw new RuntimeFailure("STOP_FAILED");
    this.states.set(target.configId, { running: false, ready: false });
  }
  async observe(target: RuntimeTarget, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.unavailable) throw new RuntimeFailure("DOCKER_UNAVAILABLE");
    return this.states.get(target.configId) ?? { running: false, ready: false };
  }
}
let app: INestApplication;
let prisma: PrismaService;
let worker: RuntimeWorker;
let generation: GenerationWorker;
let driver: ControlledDriver;
let auth: AuthResponse;
let root: string;

beforeEach(async () => {
  assert.equal(
    process.env.AUTH_TEST_RUN,
    "1",
    "Use the disposable MySQL harness",
  );
  root = await mkdtemp(join(tmpdir(), "dic-runtime-test-"));
  driver = new ControlledDriver();
  const settings = Object.assign(new GenerationSettings(), {
    root,
    pollMs: 3600000,
  });
  const module = await Test.createTestingModule({
    imports: [AppModule],
    providers: [
      PrismaService,
      GenerationSettings,
      SecretBox,
      ArtifactStore,
      RuntimeWorker,
      RuntimeSettings,
      { provide: RuntimeDriver, useValue: driver },
    ],
  })
    .overrideProvider(GenerationSettings)
    .useValue(settings)
    .overrideProvider(RuntimeSettings)
    .useValue(Object.assign(new RuntimeSettings(), { pollMs: 3600000 }))
    .compile();
  app = module.createNestApplication();
  configureApp(app);
  await app.init();
  prisma = app.get(PrismaService);
  worker = app.get(RuntimeWorker);
  generation = app.get(GenerationWorker);
  await prisma.runtimePort.deleteMany();
  await prisma.runtimeReservation.deleteMany();
  await prisma.runtimeOperation.deleteMany();
  await prisma.deployment.deleteMany();
  auth = await register();
});
afterEach(async () => {
  await app?.close();
  await rm(root, { recursive: true, force: true });
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
async function saved(owner = auth, hostPort?: number): Promise<ConfigResponse> {
  const created = (
    await request(app.getHttpServer())
      .post("/api/v1/configs")
      .auth(owner.access_token, { type: "bearer" })
      .send({
        name: "Runtime test",
        services: [
          {
            name: "web",
            image: "node",
            type: "code",
            ...(hostPort === undefined ? {} : { hostPort }),
          },
          { name: "db", image: "mysql", type: "database" },
        ],
      })
      .expect(202)
  ).body as CreateConfigResponse;
  await generation.tick();
  for (let i = 0; i < 100; i++) {
    const row = await prisma.generationAttempt.findUniqueOrThrow({
      where: { id: created.generationId },
    });
    if (row.status === "succeeded") break;
    if (row.status === "failed") throw new Error("Test generation failed");
    await setTimeout(10);
  }
  const config = (
    await request(app.getHttpServer())
      .get(`/api/v1/configs/${created.configId}`)
      .auth(owner.access_token, { type: "bearer" })
      .expect(200)
  ).body as ConfigResponse;
  assert.ok(config.revision);
  return config;
}
function start(
  config: ConfigResponse,
  owner = auth,
  key = randomUUID(),
  body: object = { revisionId: config.revision!.id },
) {
  return request(app.getHttpServer())
    .post(`/api/v1/configs/${config.id}/start`)
    .auth(owner.access_token, { type: "bearer" })
    .set("Idempotency-Key", key)
    .send(body);
}
function stop(config: ConfigResponse, owner = auth) {
  return request(app.getHttpServer())
    .post(`/api/v1/configs/${config.id}/stop`)
    .auth(owner.access_token, { type: "bearer" })
    .set("Idempotency-Key", randomUUID())
    .send({});
}
async function finish(id: string): Promise<RuntimeOperationResponse> {
  for (let i = 0; i < 150; i++) {
    const row = await prisma.runtimeOperation.findUniqueOrThrow({
      where: { id },
    });
    if (row.status === "succeeded" || row.status === "failed")
      return (
        await request(app.getHttpServer())
          .get(`/api/v1/operations/${id}`)
          .auth(
            (
              await prisma.configuration.findUniqueOrThrow({
                where: { id: row.configId },
              })
            ).userId === auth.user.id
              ? auth.access_token
              : "invalid",
            { type: "bearer" },
          )
          .expect(200)
      ).body as RuntimeOperationResponse;
    await setTimeout(10);
  }
  throw new Error("Runtime operation did not finish");
}

test("Start returns a durable 202 before execution; runner prepares private secrets, validates readiness, and leaves the deployment running", async () => {
  const config = await saved();
  const response = await start(config).expect(202);
  const accepted = response.body as RuntimeAcceptedResponse;
  assert.equal(response.headers.location, accepted.statusUrl);
  assert.equal(response.headers["retry-after"], "2");
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(driver.targets.length, 0);
  assert.equal(
    (
      await prisma.runtimeOperation.findUniqueOrThrow({
        where: { id: accepted.operationId },
      })
    ).status,
    "queued",
  );
  await worker.tick();
  assert.equal((await finish(accepted.operationId)).status, "succeeded");
  const target = driver.targets[0]!;
  assert.equal(Object.keys(target.secrets).length, 2);
  assert.ok(
    Object.values(target.secrets).every(
      (value) => !target.manifest.includes(value),
    ),
  );
  const deployment = await prisma.deployment.findUniqueOrThrow({
    where: { configId: config.id },
  });
  assert.equal(deployment.state, "running");
  assert.equal(deployment.digest, digest(deployment.manifest));
  assert.equal(
    (
      await prisma.configRevision.findUniqueOrThrow({
        where: { id: config.revision!.id },
      })
    ).compose,
    config.revision!.compose,
  );
  await start(config).expect(409);
  await request(app.getHttpServer())
    .delete(`/api/v1/configs/${config.id}`)
    .auth(auth.access_token, { type: "bearer" })
    .expect(409);
});

test("simultaneous Start replay creates one operation; changing its target rejects key reuse", async () => {
  const first = await saved();
  const second = await saved();
  const key = randomUUID();
  const results = await Promise.all([
    start(first, auth, key),
    start(first, auth, key),
  ]);
  assert.deepEqual(
    results.map((row) => row.status),
    [202, 202],
  );
  assert.equal(results[0]!.body.operationId, results[1]!.body.operationId);
  assert.equal(
    await prisma.runtimeOperation.count({ where: { configId: first.id } }),
    1,
  );
  await start(second, auth, key).expect(409);
  await start(first, auth, key, { revisionId: randomUUID() }).expect(409);
});

test("concurrent starts for different configurations reserve only one per user", async () => {
  const first = await saved();
  const second = await saved();
  const results = await Promise.all([start(first), start(second)]);
  assert.deepEqual(results.map((row) => row.status).sort(), [202, 409]);
  assert.equal(
    await prisma.runtimeReservation.count({ where: { userId: auth.user.id } }),
    1,
  );
});

test("concurrent users cannot reserve the same host port and the losing request leaves no reservation", async () => {
  const other = await register();
  const first = await saved(auth, 18080);
  const second = await saved(other, 18080);
  const results = await Promise.all([start(first), start(second, other)]);
  assert.deepEqual(results.map((row) => row.status).sort(), [202, 409]);
  assert.equal(await prisma.runtimePort.count({ where: { port: 18080 } }), 1);
  assert.equal(
    await prisma.runtimeReservation.count({
      where: { userId: { in: [auth.user.id, other.user.id] } },
    }),
    1,
  );
});

test("another runner instance claims a persisted job only once while both runners scan", async () => {
  const config = await saved();
  const accepted = (await start(config).expect(202))
    .body as RuntimeAcceptedResponse;
  const connection = new PrismaService();
  await connection.onModuleInit();
  const second = new RuntimeWorker(
    connection,
    app.get(SecretBox),
    driver,
    new RuntimeSettings(),
    app.get(ArtifactStore),
  );
  try {
    await Promise.all([worker.tick(), second.tick()]);
    assert.equal((await finish(accepted.operationId)).status, "succeeded");
    assert.equal(
      driver.targets.filter((row) => row.configId === config.id).length,
      1,
    );
  } finally {
    await second.onModuleDestroy();
    await connection.$disconnect();
  }
});

test("an expired queued Start fails without Docker mutation and releases its unused slot after inspection", async () => {
  const config = await saved();
  const accepted = (await start(config).expect(202))
    .body as RuntimeAcceptedResponse;
  await prisma.runtimeOperation.update({
    where: { id: accepted.operationId },
    data: { createdAt: new Date(0) },
  });
  await worker.tick();
  assert.equal(
    (await finish(accepted.operationId)).error?.code,
    "QUEUE_EXPIRED",
  );
  assert.equal(driver.targets.length, 0);
  assert.equal(
    await prisma.runtimeReservation.findUnique({
      where: { userId: auth.user.id },
    }),
    null,
  );
});

test("independent users can queue and run more than two configurations without a global running quota", async () => {
  const owners = [auth, await register(), await register()];
  const configs = [];
  for (const owner of owners) configs.push(await saved(owner));
  const results = await Promise.all(
    configs.map((config, index) => start(config, owners[index]!)),
  );
  assert.deepEqual(
    results.map((row) => row.status),
    [202, 202, 202],
  );
  for (let i = 0; i < 100; i++) {
    await worker.tick();
    if (
      (await prisma.deployment.count({
        where: {
          configId: { in: configs.map((row) => row.id) },
          state: "running",
        },
      })) === 3
    )
      break;
    await setTimeout(10);
  }
  assert.equal(
    await prisma.deployment.count({
      where: {
        configId: { in: configs.map((row) => row.id) },
        state: "running",
      },
    }),
    3,
  );
});

test("ownership, revocation, origin, nested revisions, and malformed payloads cannot start or observe another user's deployment", async () => {
  const config = await saved();
  const other = await register();
  await start(config, other).expect(404);
  await start(config, auth, randomUUID(), { revisionId: randomUUID() }).expect(
    400,
  );
  for (const body of [
    {},
    { revisionId: null },
    { revisionId: config.revision!.id, privileged: true },
    { revisionId: "../../outside" },
  ])
    await start(config, auth, randomUUID(), body).expect(400);
  await request(app.getHttpServer())
    .post(`/api/v1/configs/${config.id}/start`)
    .send({ revisionId: config.revision!.id })
    .expect(401);
  await start(config).set("Origin", "https://untrusted.example").expect(403);
  await request(app.getHttpServer())
    .post(`/api/v1/configs/${config.id}/start`)
    .auth(auth.access_token, { type: "bearer" })
    .send({ revisionId: config.revision!.id })
    .expect(400);
  const operation = (await start(config).expect(202))
    .body as RuntimeAcceptedResponse;
  await request(app.getHttpServer())
    .get(operation.statusUrl)
    .auth(other.access_token, { type: "bearer" })
    .expect(404);
  await request(app.getHttpServer())
    .get(`/api/v1/configs/${config.id}/deployment`)
    .auth(other.access_token, { type: "bearer" })
    .expect(404);
  await request(app.getHttpServer())
    .post("/api/v1/auth/logout")
    .auth(auth.access_token, { type: "bearer" })
    .expect(204);
  await start(config).expect(401);
});

test("failed readiness rolls back partial startup, preserves encrypted data/revisions, and releases the slot only after verified stop", async () => {
  const config = await saved();
  const revision = await prisma.configRevision.findUniqueOrThrow({
    where: { id: config.revision!.id },
  });
  const secrets = await prisma.configSecret.findMany({
    where: { configId: config.id },
  });
  driver.failStart = true;
  const operation = (await start(config).expect(202))
    .body as RuntimeAcceptedResponse;
  await worker.tick();
  const outcome = await finish(operation.operationId);
  assert.equal(outcome.error?.code, "START_FAILED");
  assert.equal(outcome.cleanupPending, false);
  assert.equal(
    await prisma.runtimeReservation.count({ where: { userId: auth.user.id } }),
    0,
  );
  assert.deepEqual(
    await prisma.configSecret.findMany({ where: { configId: config.id } }),
    secrets,
  );
  assert.deepEqual(
    await prisma.configRevision.findUniqueOrThrow({
      where: { id: revision.id },
    }),
    revision,
  );
  driver.failStart = false;
  await start(config).expect(202);
});

test("failed rollback keeps its slot; a later explicit Stop releases it and preserves database secrets", async () => {
  const config = await saved();
  const second = await saved();
  driver.failStart = true;
  driver.failStop = true;
  const operation = (await start(config).expect(202))
    .body as RuntimeAcceptedResponse;
  await worker.tick();
  assert.equal((await finish(operation.operationId)).cleanupPending, true);
  await start(second).expect(409);
  driver.failStop = false;
  const stopped = (await stop(config).expect(202))
    .body as RuntimeAcceptedResponse;
  await worker.tick();
  assert.equal((await finish(stopped.operationId)).status, "succeeded");
  assert.equal(
    await prisma.configSecret.count({ where: { configId: config.id } }),
    2,
  );
  await start(second).expect(202);
});

test("Stop then Start reuses a stable manifest and volumes; each action requires its own key", async () => {
  const config = await saved();
  const started = (await start(config).expect(202))
    .body as RuntimeAcceptedResponse;
  await worker.tick();
  await finish(started.operationId);
  const manifest = (
    await prisma.deployment.findUniqueOrThrow({
      where: { configId: config.id },
    })
  ).manifest;
  await stop(config).send({ command: "arbitrary" }).expect(400);
  const stopped = (await stop(config).expect(202))
    .body as RuntimeAcceptedResponse;
  await worker.tick();
  await finish(stopped.operationId);
  const restarted = (await start(config).expect(202))
    .body as RuntimeAcceptedResponse;
  await worker.tick();
  await finish(restarted.operationId);
  assert.equal(
    (
      await prisma.deployment.findUniqueOrThrow({
        where: { configId: config.id },
      })
    ).manifest,
    manifest,
  );
});

test("reconciliation keeps partial or unknown deployments reserved and never automatically restarts them", async () => {
  const config = await saved();
  const operation = (await start(config).expect(202))
    .body as RuntimeAcceptedResponse;
  await worker.tick();
  await finish(operation.operationId);
  driver.unavailable = true;
  await worker.tick();
  assert.equal(
    (
      await prisma.deployment.findUniqueOrThrow({
        where: { configId: config.id },
      })
    ).state,
    "unknown",
  );
  assert.ok(
    await prisma.runtimeReservation.findUnique({
      where: { userId: auth.user.id },
    }),
  );
  driver.unavailable = false;
  driver.states.set(config.id, { running: true, ready: false });
  await worker.tick();
  assert.ok(
    await prisma.runtimeReservation.findUnique({
      where: { userId: auth.user.id },
    }),
  );
  driver.states.set(config.id, { running: false, ready: false });
  await worker.tick();
  assert.equal(
    await prisma.runtimeReservation.findUnique({
      where: { userId: auth.user.id },
    }),
    null,
  );
  assert.equal(driver.targets.length, 1);
});

test("expired running leases are fenced and reconciled without replaying Start", async () => {
  const config = await saved();
  const accepted = (await start(config).expect(202))
    .body as RuntimeAcceptedResponse;
  await prisma.runtimeOperation.update({
    where: { id: accepted.operationId },
    data: {
      status: "running",
      leaseToken: randomUUID(),
      deadlineAt: new Date(0),
      leaseExpiresAt: new Date(0),
    },
  });
  driver.states.set(config.id, { running: true, ready: false });
  await worker.tick();
  const row = await prisma.runtimeOperation.findUniqueOrThrow({
    where: { id: accepted.operationId },
  });
  assert.equal(row.status, "failed");
  assert.equal(row.errorCode, "INTERRUPTED");
  assert.equal(driver.targets.length, 0);
  assert.ok(
    await prisma.runtimeReservation.findUnique({
      where: { userId: auth.user.id },
    }),
  );
});

test("a tampered saved specification or Compose digest is rejected before queueing", async () => {
  const config = await saved();
  await prisma.configRevision.update({
    where: { id: config.revision!.id },
    data: {
      spec: {
        schemaVersion: 1,
        catalogVersion: 1,
        services: [
          { name: "web", type: "code", image: "node", privileged: true },
        ],
      },
    },
  });
  await start(config).expect(400);
  assert.equal(
    await prisma.runtimeOperation.count({ where: { configId: config.id } }),
    0,
  );
  assert.equal(
    await prisma.runtimeReservation.count({ where: { userId: auth.user.id } }),
    0,
  );
});

test("runtime manifest isolates workloads, drops raw sockets, labels all resources, and uses authenticated database probes", async () => {
  const services = revisionServices({
    schemaVersion: 1,
    catalogVersion: 1,
    services: [{ name: "db", type: "database", image: "mongodb" }],
  });
  const manifest = JSON.parse(
    runtimeManifest(auth.user.id, randomUUID(), randomUUID(), services),
  ) as {
    networks: {
      stack: { internal: boolean; driver_opts: Record<string, string> };
    };
    services: { db: { cap_drop: string[]; healthcheck: { test: string[] } } };
    volumes: Record<string, { labels: object }>;
  };
  assert.equal(manifest.networks.stack.internal, true);
  assert.equal(
    manifest.networks.stack.driver_opts[
      "com.docker.network.bridge.gateway_mode_ipv4"
    ],
    "isolated",
  );
  assert.deepEqual(manifest.services.db.cap_drop, ["NET_RAW"]);
  assert.ok(manifest.services.db.healthcheck.test.includes("mongosh"));
  assert.deepEqual(Object.keys(manifest.volumes), ["db-data", "db-configdb"]);
  for (const volume of Object.values(manifest.volumes))
    assert.ok(volume.labels);
});

test("real Docker capability gate rejects an older daemon before creating workloads", async (context) => {
  const version = execFileSync(
    "docker",
    ["version", "--format", "{{.Server.Version}}"],
    { encoding: "utf8" },
  ).trim();
  if (Number(version.split(".")[0]) >= 28) {
    context.skip("Host supports isolation; run the opt-in workload smoke test");
    return;
  }
  const config = await saved();
  const services = revisionServices(
    (
      await prisma.configRevision.findUniqueOrThrow({
        where: { id: config.revision!.id },
      })
    ).spec,
  );
  await assert.rejects(
    new DockerRuntimeDriver().start(
      {
        userId: auth.user.id,
        configId: config.id,
        revisionId: config.revision!.id,
        services,
        manifest: runtimeManifest(
          auth.user.id,
          config.id,
          config.revision!.id,
          services,
        ),
        secrets: {},
      },
      AbortSignal.timeout(15000),
    ),
    (error: unknown) =>
      error instanceof RuntimeFailure && error.code === "UNSUPPORTED_DOCKER",
  );
  assert.equal(
    execFileSync(
      "docker",
      [
        "ps",
        "--all",
        "--quiet",
        "--filter",
        `label=com.docker.compose.project=dic-${config.id}`,
      ],
      { encoding: "utf8" },
    ).trim(),
    "",
  );
});
