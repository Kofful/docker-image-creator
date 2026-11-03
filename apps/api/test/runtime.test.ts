import "reflect-metadata";
import assert from "node:assert/strict";
import { beforeEach, afterEach, test } from "node:test";
import { randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import { access, mkdtemp, rm } from "node:fs/promises";
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
  ServiceRuntimeResponse,
  ConfigServicesResponse,
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
  runtimeLabels,
  revisionServices,
  runtimeManifest,
} from "../src/runtime/runtime.manifest";
import { unknownService } from "../src/runtime/runtime.observations";

class ControlledDriver extends RuntimeDriver {
  states = new Map<string, { running: boolean | undefined; ready: boolean }>();
  targets: RuntimeTarget[] = [];
  failStart = false;
  failStop = false;
  failDelete = false;
  removed: string[] = [];
  async remove(target: RuntimeTarget, signal: AbortSignal) {
    signal.throwIfAborted();
    if (this.failDelete || this.states.get(target.configId)?.running)
      throw new RuntimeFailure("DELETE_FAILED");
    this.removed.push(target.configId);
    this.states.delete(target.configId);
  }
  unavailable = false;
  observations = new Map<string, ServiceRuntimeResponse[]>();
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
    const state = this.states.get(target.configId);
    return {
      ...(state ?? { running: false, ready: false }),
      services:
        this.observations.get(target.configId) ??
        target.services.map(
          (service): ServiceRuntimeResponse => ({
            ...unknownService(service),
            state: !state
              ? "not_created"
              : state.running
                ? "running"
                : "exited",
            health: state?.ready
              ? "healthy"
              : state?.running
                ? "unhealthy"
                : null,
            publishedPort:
              state?.running && service.hostPort !== undefined
                ? {
                    host: "127.0.0.1",
                    hostPort: service.hostPort,
                    containerPort: 8000,
                  }
                : null,
            observedAt: new Date().toISOString(),
          }),
        ),
    };
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
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(GenerationSettings)
    .useValue(settings)
    .overrideProvider(ArtifactStore)
    .useValue(new ArtifactStore(settings))
    .compile();
  app = module.createNestApplication();
  configureApp(app);
  await app.init();
  prisma = app.get(PrismaService);
  worker = new RuntimeWorker(
    prisma,
    app.get(SecretBox),
    driver,
    Object.assign(new RuntimeSettings(), { pollMs: 3600000 }),
    app.get(ArtifactStore),
  );
  generation = app.get(GenerationWorker);
  await prisma.runtimePort.deleteMany();
  await prisma.runtimeReservation.deleteMany();
  await prisma.runtimeOperation.deleteMany();
  await prisma.deployment.deleteMany();
  auth = await register();
});
async function teardown() {
  await worker?.onModuleDestroy();
  await generation?.onModuleDestroy();
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
afterEach(teardown);

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

test("service observations are owner-scoped, read-only, and unknown before the runner observes resources", async () => {
  const config = await saved(auth, 8081);
  const path = `/api/v1/configs/${config.id}/services`;
  await request(app.getHttpServer()).get(path).expect(401);
  const other = await register();
  await request(app.getHttpServer())
    .get(path)
    .auth(other.access_token, { type: "bearer" })
    .expect(404);
  const response = await request(app.getHttpServer())
    .get(path)
    .auth(auth.access_token, { type: "bearer" })
    .expect(200);
  const body = response.body as ConfigServicesResponse;
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(body.configId, config.id);
  assert.equal(body.revisionId, null);
  assert.deepEqual(
    body.services.map((row) => [
      row.name,
      row.image,
      row.state,
      row.publishedPort,
      row.observedAt,
    ]),
    [
      ["web", "node:22.23.4-bookworm-slim", "unknown", null, null],
      ["db", "mysql:8.4.11", "unknown", null, null],
    ],
  );
  assert.equal(
    await prisma.deployment.count({ where: { configId: config.id } }),
    0,
  );
  assert.equal(driver.targets.length, 0);
  await request(app.getHttpServer())
    .delete(`/api/v1/configs/${config.id}`)
    .auth(auth.access_token, { type: "bearer" })
    .expect(204);
  await request(app.getHttpServer())
    .get(path)
    .auth(auth.access_token, { type: "bearer" })
    .expect(404);
});

test("runner persists service observations through Start, partial health, unknown inspection, recovery, and Stop", async () => {
  const config = await saved(auth, 8081);
  const path = `/api/v1/configs/${config.id}/services`;
  const get = async () =>
    (
      await request(app.getHttpServer())
        .get(path)
        .auth(auth.access_token, { type: "bearer" })
        .expect(200)
    ).body as ConfigServicesResponse;
  const started = (await start(config).expect(202))
    .body as RuntimeAcceptedResponse;
  await worker.tick();
  assert.equal((await finish(started.operationId)).status, "succeeded");
  const running = await get();
  assert.equal(running.revisionId, config.revision!.id);
  assert.equal(running.operationId, started.operationId);
  assert.equal(running.services[0]?.state, "running");
  assert.equal(running.services[0]?.health, "healthy");
  assert.deepEqual(running.services[0]?.publishedPort, {
    host: "127.0.0.1",
    hostPort: 8081,
    containerPort: 8000,
  });
  assert.ok(running.services[0]?.observedAt);
  driver.states.set(config.id, { running: true, ready: false });
  driver.observations.set(config.id, [
    { ...running.services[0]!, health: "unhealthy" },
    unknownService({ name: "db", image: "mysql", type: "database" }),
  ]);
  await worker.tick();
  const partial = await get();
  assert.equal(partial.services[0]?.state, "running");
  assert.equal(partial.services[0]?.health, "unhealthy");
  assert.equal(partial.services[1]?.state, "unknown");
  assert.equal(
    await prisma.runtimeReservation.count({ where: { configId: config.id } }),
    1,
  );
  driver.states.set(config.id, { running: undefined, ready: false });
  driver.observations.set(config.id, config.services.map(unknownService));
  await worker.tick();
  assert.equal(
    (await get()).services.every((row) => row.state === "unknown"),
    true,
  );
  assert.equal(
    (
      await prisma.deployment.findUniqueOrThrow({
        where: { configId: config.id },
      })
    ).state,
    "unknown",
  );
  assert.equal(
    await prisma.runtimeReservation.count({ where: { configId: config.id } }),
    1,
  );
  driver.unavailable = true;
  await worker.tick();
  assert.equal(
    (await get()).services.every((row) => row.observedAt === null),
    true,
  );
  driver.unavailable = false;
  driver.observations.delete(config.id);
  const stopped = (await stop(config).expect(202))
    .body as RuntimeAcceptedResponse;
  await worker.tick();
  assert.equal((await finish(stopped.operationId)).status, "succeeded");
  const final = await get();
  assert.equal(final.operationId, stopped.operationId);
  assert.equal(
    final.services.every(
      (row) => row.state === "exited" && row.publishedPort === null,
    ),
    true,
  );
});

test("service responses select safe fields and discard malformed or mismatched observations", async () => {
  const config = await saved();
  const started = (await start(config).expect(202))
    .body as RuntimeAcceptedResponse;
  await worker.tick();
  await finish(started.operationId);
  const target = driver.targets[0]!;
  const good = (await driver.observe(target, AbortSignal.timeout(1000)))
    .services;
  await prisma.deployment.update({
    where: { configId: config.id },
    data: {
      serviceObservations: [
        { ...good[0]!, Id: "private-id", Env: ["PASSWORD=private-value"] },
        { ...good[1]!, image: "foreign:latest" },
        { ...good[0]!, name: "unrequested" },
      ],
    },
  });
  const result = await request(app.getHttpServer())
    .get(`/api/v1/configs/${config.id}/services`)
    .auth(auth.access_token, { type: "bearer" })
    .expect(200);
  assert.equal(result.body.services.length, 2);
  assert.equal(result.body.services[0].state, "running");
  assert.equal(result.body.services[1].state, "unknown");
  assert.ok(!JSON.stringify(result.body).includes("private"));
  assert.ok(!JSON.stringify(result.body).includes("unrequested"));
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
  await request(app.getHttpServer())
    .get(`/api/v1/configs/${config.id}/services`)
    .auth(auth.access_token, { type: "bearer" })
    .expect(401);
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
    // Dynamic skip bypasses afterEach on the supported Node test runner.
    await teardown();
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

function remove(
  config: ConfigResponse,
  key: string = randomUUID(),
  owner = auth,
) {
  return request(app.getHttpServer())
    .delete(`/api/v1/configs/${config.id}`)
    .auth(owner.access_token, { type: "bearer" })
    .set("Idempotency-Key", key);
}
async function stoppedConfig() {
  const config = await saved();
  const started = (await start(config).expect(202))
    .body as RuntimeAcceptedResponse;
  await worker.tick();
  await finish(started.operationId);
  const stopped = (await stop(config).expect(202))
    .body as RuntimeAcceptedResponse;
  await worker.tick();
  await finish(stopped.operationId);
  return config;
}
test("Delete queues owned stopped-resource cleanup, stays visible until verified, and retains volume recovery metadata", async () => {
  const config = await stoppedConfig();
  const secrets = await prisma.configSecret.findMany({
    where: { configId: config.id },
  });
  const key = randomUUID();
  const response = await remove(config, key).expect(202);
  const accepted = response.body as RuntimeAcceptedResponse;
  assert.equal(response.headers.location, accepted.statusUrl);
  assert.equal(response.headers["retry-after"], "2");
  assert.equal(driver.removed.length, 0);
  const visible = (
    await request(app.getHttpServer())
      .get(`/api/v1/configs/${config.id}`)
      .auth(auth.access_token, { type: "bearer" })
      .expect(200)
  ).body as ConfigResponse;
  assert.equal(visible.deletion?.status, "queued");
  await access(join(root, auth.user.id, config.id));
  await start(config).expect(409);
  await stop(config).expect(409);
  await worker.tick();
  assert.equal((await finish(accepted.operationId)).status, "succeeded");
  assert.deepEqual(driver.removed, [config.id]);
  await assert.rejects(access(join(root, auth.user.id, config.id)));
  await request(app.getHttpServer())
    .get(`/api/v1/configs/${config.id}`)
    .auth(auth.access_token, { type: "bearer" })
    .expect(404);
  const list = (
    await request(app.getHttpServer())
      .get("/api/v1/configs")
      .auth(auth.access_token, { type: "bearer" })
  ).body as ConfigResponse[];
  assert.ok(!list.some((row) => row.id === config.id));
  assert.deepEqual(
    await prisma.configSecret.findMany({ where: { configId: config.id } }),
    secrets,
  );
  assert.ok(
    await prisma.configRevision.findUnique({
      where: { id: config.revision!.id },
    }),
  );
  assert.ok(
    await prisma.deployment.findUnique({ where: { configId: config.id } }),
  );
  assert.equal(
    (await remove(config, key).expect(202)).body.operationId,
    accepted.operationId,
  );
  await remove(config).expect(404);
  const other = await register();
  await request(app.getHttpServer())
    .get(accepted.statusUrl)
    .auth(other.access_token, { type: "bearer" })
    .expect(404);
  await remove(config, key, other).expect(404);
});
test("concurrent Delete requests share one job and cannot race a new Start", async () => {
  const config = await stoppedConfig();
  const key = randomUUID();
  const results = await Promise.all([
    remove(config, key),
    remove(config, key),
    start(config),
  ]);
  // Either Start wins admission or deletion wins; neither can run concurrently.
  if (results[0]!.status === 202) {
    assert.equal(results[1]!.body.operationId, results[0]!.body.operationId);
    assert.equal(results[2]!.status, 409);
    assert.equal(
      await prisma.runtimeOperation.count({
        where: { configId: config.id, type: "delete" },
      }),
      1,
    );
  } else {
    assert.equal(results[0]!.status, 409);
    assert.equal(results[1]!.status, 409);
    assert.equal(results[2]!.status, 202);
  }
});
test("failed Delete stays visible, blocks Start, retains its error through reconciliation, and succeeds on explicit retry", async () => {
  const config = await stoppedConfig();
  driver.failDelete = true;
  const key = randomUUID();
  const first = (await remove(config, key).expect(202))
    .body as RuntimeAcceptedResponse;
  await worker.tick();
  assert.equal((await finish(first.operationId)).cleanupPending, true);
  await worker.tick();
  assert.equal((await finish(first.operationId)).cleanupPending, true);
  await start(config).expect(409);
  await access(join(root, auth.user.id, config.id));
  assert.equal(
    (await remove(config, key).expect(202)).body.operationId,
    first.operationId,
  );
  driver.failDelete = false;
  const retry = (await remove(config).expect(202))
    .body as RuntimeAcceptedResponse;
  assert.notEqual(retry.operationId, first.operationId);
  await worker.tick();
  assert.equal((await finish(retry.operationId)).status, "succeeded");
});
test("file cleanup failure keeps deletion visible and retryable after Docker resources are already removed", async () => {
  const config = await stoppedConfig();
  const files = app.get(ArtifactStore);
  const original = files.removeConfig.bind(files);
  files.removeConfig = async () => {
    throw new Error("test file failure");
  };
  const first = (await remove(config).expect(202))
    .body as RuntimeAcceptedResponse;
  await worker.tick();
  assert.equal((await finish(first.operationId)).error?.code, "DELETE_FAILED");
  assert.equal(
    (await prisma.configuration.findUniqueOrThrow({ where: { id: config.id } }))
      .deletedAt,
    null,
  );
  await start(config).expect(409);
  files.removeConfig = original;
  const retry = (await remove(config).expect(202))
    .body as RuntimeAcceptedResponse;
  await worker.tick();
  assert.equal((await finish(retry.operationId)).status, "succeeded");
});
test("expired Delete leases retain visible intent and require an explicit retry", async () => {
  const config = await stoppedConfig();
  const first = (await remove(config).expect(202))
    .body as RuntimeAcceptedResponse;
  await prisma.runtimeOperation.update({
    where: { id: first.operationId },
    data: {
      status: "running",
      leaseToken: randomUUID(),
      deadlineAt: new Date(0),
      leaseExpiresAt: new Date(0),
    },
  });
  await worker.tick();
  assert.equal((await finish(first.operationId)).error?.code, "INTERRUPTED");
  assert.equal(driver.removed.length, 0);
  await start(config).expect(409);
  const retry = (await remove(config).expect(202))
    .body as RuntimeAcceptedResponse;
  await worker.tick();
  assert.equal((await finish(retry.operationId)).status, "succeeded");
});
test("Delete enforces ownership, authentication, origin, keys, and a fresh runner check of stopped state", async () => {
  const config = await stoppedConfig();
  const other = await register();
  await remove(config, randomUUID(), other).expect(404);
  await remove(config, "invalid").expect(400);
  await remove(config).set("Origin", "https://untrusted.example").expect(403);
  await request(app.getHttpServer())
    .delete(`/api/v1/configs/${config.id}`)
    .expect(401);
  const prior = await prisma.runtimeOperation.findFirstOrThrow({
    where: { configId: config.id, type: "start" },
  });
  await remove(config, prior.requestKey).expect(409);
  // The API saw Stopped, but an external actor restarted a container before execution.
  driver.states.set(config.id, { running: true, ready: true });
  const accepted = (await remove(config).expect(202))
    .body as RuntimeAcceptedResponse;
  await worker.tick();
  assert.equal((await finish(accepted.operationId)).status, "failed");
  assert.equal(driver.removed.length, 0);
  assert.equal(
    (await prisma.configuration.findUniqueOrThrow({ where: { id: config.id } }))
      .deletedAt,
    null,
  );
});

test("real Docker Delete removes only its stopped containers/network and preserves its named database volume", async (context) => {
  const env = {
    PATH: "/usr/local/bin:/usr/bin:/bin",
    DOCKER_HOST: "unix:///var/run/docker.sock",
  };
  const docker = (args: string[]) =>
    execFileSync("docker", args, {
      env,
      encoding: "utf8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  if (
    Number(
      docker(["version", "--format", "{{.Server.Version}}"]).split(".")[0],
    ) < 28
  ) {
    await teardown();
    context.skip("Disposable cleanup check requires Docker Engine 28+");
    return;
  }
  const userId = randomUUID(),
    configId = randomUUID(),
    revisionId = randomUUID();
  const project = `dic-${configId}`;
  const network = `${project}_stack`,
    volume = `${project}_db-data`;
  const labels = runtimeLabels(userId, configId);
  const labelArgs = Object.entries(labels).flatMap(([key, value]) => [
    "--label",
    `${key}=${value}`,
  ]);
  const target: RuntimeTarget = {
    userId,
    configId,
    revisionId,
    services: [{ name: "db", type: "database", image: "mysql" }],
    manifest: "",
    secrets: {},
  };
  target.manifest = runtimeManifest(
    userId,
    configId,
    revisionId,
    target.services,
  );
  let container: string | undefined;
  let networkCreated = false,
    volumeCreated = false;
  const owned = (observed: Record<string, string>) => {
    for (const [key, value] of Object.entries(labels))
      assert.equal(observed[key], value);
  };
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
    networkCreated = true;
    docker(["volume", "create", ...labelArgs, volume]);
    volumeCreated = true;
    container = docker([
      "create",
      "--name",
      `${project}-db-test`,
      ...labelArgs,
      "--label",
      `com.docker.compose.project=${project}`,
      "--label",
      "com.docker.compose.service=db",
      "--label",
      `docker-image-creator.revision=${revisionId}`,
      "--network",
      network,
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
      "--mount",
      `type=volume,source=${volume},target=/var/lib/mysql`,
      "mysql:8.4.11",
    ]);
    const live = new DockerRuntimeDriver();
    const created = await live.observe(target, AbortSignal.timeout(15000));
    assert.equal(created.running, false);
    assert.equal(created.services[0]?.state, "created");
    assert.equal(created.services[0]?.image, "mysql:8.4.11");
    assert.ok(created.services[0]?.observedAt);
    await live.remove(target, AbortSignal.timeout(15000));
    const removed = await live.observe(target, AbortSignal.timeout(15000));
    assert.equal(removed.running, false);
    assert.equal(removed.services[0]?.state, "not_created");
    assert.equal(
      docker([
        "ps",
        "--all",
        "--quiet",
        "--filter",
        `label=com.docker.compose.project=${project}`,
      ]),
      "",
    );
    assert.equal(
      docker(["network", "ls", "--quiet", "--filter", `name=^${network}$`]),
      "",
    );
    owned(
      JSON.parse(
        docker(["volume", "inspect", "--format", "{{json .Labels}}", volume]),
      ) as Record<string, string>,
    );
    await live.remove(target, AbortSignal.timeout(15000));
  } finally {
    if (
      container &&
      docker(["ps", "--all", "--quiet", "--filter", `id=${container}`])
    ) {
      owned(
        JSON.parse(
          docker(["inspect", "--format", "{{json .Config.Labels}}", container]),
        ) as Record<string, string>,
      );
      docker(["rm", "--force", container]);
    }
    if (
      networkCreated &&
      docker(["network", "ls", "--quiet", "--filter", `name=^${network}$`])
    ) {
      owned(
        JSON.parse(
          docker([
            "network",
            "inspect",
            "--format",
            "{{json .Labels}}",
            network,
          ]),
        ) as Record<string, string>,
      );
      docker(["network", "rm", network]);
    }
    if (volumeCreated) {
      owned(
        JSON.parse(
          docker(["volume", "inspect", "--format", "{{json .Labels}}", volume]),
        ) as Record<string, string>,
      );
      docker(["volume", "rm", volume]);
    }
  }
});
