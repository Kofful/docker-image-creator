import "reflect-metadata";
import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";
import type {
  AuthResponse,
  ConfigResponse,
  CreateConfigRequest,
  CreateConfigResponse,
  GenerationResponse,
} from "@docker-image-creator/contracts";
import { AppModule } from "../src/app.module";
import { configureApp } from "../src/configure-app";
import { PrismaService } from "../src/database/prisma.service";
import {
  GenerationProvider,
  type GenerationInput,
} from "../src/configs/generation.provider";
import { GenerationSettings } from "../src/configs/generation.settings";
import { GenerationWorker } from "../src/configs/generation.worker";
import { SecretBox } from "../src/configs/secret-box";
import {
  compileCompose,
  parseCandidate,
} from "../src/configs/compose.compiler";
import { ArtifactStore } from "../src/configs/artifact.store";

let app: INestApplication;
let prisma: PrismaService;
let worker: GenerationWorker;
let root: string;
let auth: AuthResponse;
let settings: GenerationSettings;
let generate: (input: GenerationInput, signal: AbortSignal) => Promise<string>;
const input: CreateConfigRequest = {
  name: "Starter and database",
  instructions: "Use catalog services",
  services: [
    {
      name: "api",
      type: "code",
      image: "node",
      language: "javascript",
      hostPort: 18080,
    },
    { name: "db", type: "database", image: "mysql", database: "app" },
  ],
};

async function start() {
  const module = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(GenerationSettings)
    .useValue(settings)
    .overrideProvider(GenerationProvider)
    .useValue({
      generate: (value: GenerationInput, signal: AbortSignal) =>
        generate(value, signal),
    })
    .compile();
  app = module.createNestApplication();
  configureApp(app);
  await app.init();
  prisma = app.get(PrismaService);
  worker = app.get(GenerationWorker);
}
beforeEach(async () => {
  assert.equal(
    process.env.AUTH_TEST_RUN,
    "1",
    "Use the disposable MySQL harness",
  );
  root = await mkdtemp(join(tmpdir(), "dic-generation-"));
  settings = Object.assign(new GenerationSettings(), {
    root,
    pollMs: 3600000,
    generationMs: 2000,
    leaseGraceMs: 1000,
  });
  generate = async (value) =>
    JSON.stringify({ schemaVersion: 1, services: value.services });
  await start();
  await prisma.configuration.deleteMany();
  await prisma.generationSlot.updateMany({
    data: { generationId: null, leaseToken: null, leaseExpiresAt: null },
  });
  auth = await register();
});
afterEach(async () => {
  await worker?.onModuleDestroy();
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
function create(
  body: object = input,
  token = auth.access_token,
  key = randomUUID(),
) {
  return request(app.getHttpServer())
    .post("/api/v1/configs")
    .auth(token, { type: "bearer" })
    .set("Idempotency-Key", key)
    .send(body);
}
async function status(
  id: string,
  token = auth.access_token,
): Promise<GenerationResponse> {
  return (
    await request(app.getHttpServer())
      .get(`/api/v1/generations/${id}`)
      .auth(token, { type: "bearer" })
      .expect(200)
  ).body as GenerationResponse;
}
async function finished(id: string): Promise<GenerationResponse> {
  for (let attempt = 0; attempt < 150; attempt++) {
    const result = await status(id);
    if (result.status === "succeeded" || result.status === "failed")
      return result;
    await setTimeout(10);
  }
  throw new Error("Generation did not finish");
}

test("creation returns 202 before provider completion, then saves DB revision and private Compose file", async () => {
  let release!: (value: string) => void;
  generate = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const response = await create().timeout({ response: 1000 }).expect(202);
  const created = response.body as CreateConfigResponse;
  assert.equal(response.headers.location, created.statusUrl);
  assert.equal(response.headers["retry-after"], "2");
  assert.equal((await status(created.generationId)).status, "queued");
  assert.ok(
    await prisma.configuration.findUnique({ where: { id: created.configId } }),
  );
  await worker.tick();
  for (let i = 0; !release && i < 50; i++) await setTimeout(10);
  assert.equal((await status(created.generationId)).status, "running");
  release(JSON.stringify({ schemaVersion: 1, services: input.services }));
  assert.equal((await finished(created.generationId)).status, "succeeded");
  const detail = (
    await request(app.getHttpServer())
      .get(`/api/v1/configs/${created.configId}`)
      .auth(auth.access_token, { type: "bearer" })
      .expect(200)
  ).body as ConfigResponse;
  assert.ok(detail.revision);
  const path = join(root, detail.revision.artifactPath);
  const compose = await readFile(path, "utf8");
  assert.equal(compose, detail.revision.compose);
  assert.equal(
    createHash("sha256").update(compose).digest("hex"),
    detail.revision.digest,
  );
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const document = JSON.parse(compose) as {
    services: Record<string, Record<string, unknown>>;
    networks: object;
  };
  assert.equal("build" in document.services.api!, false);
  assert.equal(document.services.db!.ports, undefined);
  assert.deepEqual(document.networks, { stack: { driver: "bridge" } });
  assert.equal(detail.generation.runtimeValidation, "not_performed");
  const secrets = await prisma.configSecret.findMany({
    where: { configId: created.configId },
  });
  assert.equal(secrets.length, 2);
  for (const secret of secrets) {
    const value = app
      .get(SecretBox)
      .open(secret.valueEncrypted, `${created.configId}:${secret.name}`);
    assert.ok(value.length > 32);
    assert.equal(compose.includes(value), false);
    assert.equal(secret.valueEncrypted.includes(value), false);
  }
  const row = await prisma.generationAttempt.findUniqueOrThrow({
    where: { id: created.generationId },
  });
  assert.equal(row.inputEncrypted.includes(input.instructions!), false);
  assert.equal(
    app.get(SecretBox).open(row.outputEncrypted!, row.id),
    JSON.stringify({ schemaVersion: 1, services: input.services }),
  );
});

test("idempotent creation returns one job and rejects key reuse with different input", async () => {
  const key = randomUUID();
  const responses = await Promise.all([
    create(input, auth.access_token, key),
    create(input, auth.access_token, key),
  ]);
  assert.deepEqual(
    responses.map((row) => row.status),
    [202, 202],
  );
  assert.equal(responses[0]!.body.configId, responses[1]!.body.configId);
  assert.equal(
    await prisma.configuration.count({ where: { userId: auth.user.id } }),
    1,
  );
  await create({ ...input, name: "Changed" }, auth.access_token, key).expect(
    409,
  );
  await create().expect(409);
});

test("strict DTO/catalog validation rejects unknown fields, unsafe names, excessive services and inconsistent settings", async () => {
  for (const body of [
    { ...input, privileged: true },
    { ...input, name: " " },
    {
      ...input,
      services: [{ name: "../escape", type: "code", image: "node" }],
    },
    {
      ...input,
      services: [...input.services, ...input.services, ...input.services],
    },
    { ...input, services: [{ ...input.services[0], image: "java" }] },
    { ...input, services: [{ ...input.services[0], privileged: true }] },
    { ...input, services: [{ ...input.services[0], type: "database" }] },
    { ...input, services: [{ ...input.services[0], language: "python" }] },
    { ...input, services: [input.services[0], input.services[0]] },
    { ...input, services: [{ ...input.services[0], hostPort: 80 }] },
    { ...input, services: [{ ...input.services[0], hostPort: null }] },
    { ...input, instructions: null },
    { ...input, description: null },
  ])
    await create(body).expect(400);
  assert.equal(await prisma.configuration.count(), 0);
});

test("configuration and polling endpoints enforce ownership, authentication, origin and session revocation", async () => {
  const created = (await create().expect(202)).body as CreateConfigResponse;
  const other = await register();
  for (const path of [
    `/configs/${created.configId}`,
    `/generations/${created.generationId}`,
  ]) {
    await request(app.getHttpServer()).get(`/api/v1${path}`).expect(401);
    await request(app.getHttpServer())
      .get(`/api/v1${path}`)
      .auth(other.access_token, { type: "bearer" })
      .expect(404);
    await request(app.getHttpServer())
      .get(`/api/v1${path}`)
      .auth(auth.access_token, { type: "bearer" })
      .set("Origin", "https://evil.example")
      .expect(403);
  }
  const list = await request(app.getHttpServer())
    .get("/api/v1/configs")
    .auth(other.access_token, { type: "bearer" })
    .expect(200);
  assert.deepEqual(list.body, []);
  await request(app.getHttpServer())
    .post("/api/v1/auth/logout")
    .auth(auth.access_token, { type: "bearer" })
    .expect(204);
  await request(app.getHttpServer())
    .get(created.statusUrl)
    .auth(auth.access_token, { type: "bearer" })
    .expect(401);
});

for (const output of [
  "not json",
  '{"schemaVersion":1,"services":[],"privileged":true}',
  JSON.stringify({
    schemaVersion: 1,
    services: [
      { ...input.services[0], command: ["sh", "-c", "evil"] },
      input.services[1],
    ],
  }),
]) {
  test("invalid/adversarial provider output remains encrypted in DB and creates no runnable revision", async () => {
    generate = async () => output;
    const created = (await create().expect(202)).body as CreateConfigResponse;
    await worker.tick();
    const result = await finished(created.generationId);
    assert.equal(result.status, "failed");
    assert.equal(result.error?.code, "INVALID_OUTPUT");
    const saved = await prisma.generationAttempt.findUniqueOrThrow({
      where: { id: result.id },
    });
    assert.equal(
      app.get(SecretBox).open(saved.outputEncrypted!, result.id),
      output,
    );
    assert.equal(await prisma.configRevision.count(), 0);
    await assert.rejects(stat(join(root, auth.user.id)), { code: "ENOENT" });
  });
}

test("output size overflow is bounded, marked truncated and never made runnable", async () => {
  generate = async () => "x".repeat(settings.maxOutputBytes + 100);
  const created = (await create().expect(202)).body as CreateConfigResponse;
  await worker.tick();
  assert.equal(
    (await finished(created.generationId)).error?.code,
    "OUTPUT_TOO_LARGE",
  );
  const saved = await prisma.generationAttempt.findUniqueOrThrow({
    where: { id: created.generationId },
  });
  assert.equal(saved.outputTruncated, true);
  assert.equal(
    Buffer.byteLength(
      app.get(SecretBox).open(saved.outputEncrypted!, saved.id),
    ),
    settings.maxOutputBytes,
  );
});

test("provider deadline fails the job and late output cannot publish a revision", async () => {
  Object.assign(settings, { generationMs: 80 });
  let release!: (value: string) => void;
  generate = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const created = (await create().expect(202)).body as CreateConfigResponse;
  await worker.tick();
  assert.equal(
    (await finished(created.generationId)).error?.code,
    "GENERATION_TIMEOUT",
  );
  release(JSON.stringify({ schemaVersion: 1, services: input.services }));
  await setTimeout(30);
  assert.equal(await prisma.configRevision.count(), 0);
});

test("queued jobs survive an API restart and completed status remains readable", async () => {
  const created = (await create().expect(202)).body as CreateConfigResponse;
  await worker.onModuleDestroy();
  await app.close();
  await start();
  await worker.tick();
  assert.equal((await finished(created.generationId)).status, "succeeded");
  await worker.onModuleDestroy();
  await app.close();
  await start();
  assert.equal((await status(created.generationId)).status, "succeeded");
});

test("two workers claim each job once and obey the two-slot global cap", async () => {
  const other = await register();
  const third = await register();
  const a = (await create().expect(202)).body as CreateConfigResponse;
  const b = (await create(input, other.access_token).expect(202))
    .body as CreateConfigResponse;
  const c = (await create(input, third.access_token).expect(202))
    .body as CreateConfigResponse;
  let calls = 0;
  generate = async (value, signal) => {
    calls++;
    await setTimeout(500, undefined, { signal });
    return JSON.stringify({ schemaVersion: 1, services: value.services });
  };
  const second = new GenerationWorker(
    prisma,
    app.get(GenerationProvider),
    settings,
    app.get(SecretBox),
    app.get(ArtifactStore),
  );
  await Promise.all([worker.tick(), second.tick()]);
  for (let i = 0; calls < 2 && i < 50; i++) await setTimeout(10);
  assert.equal(calls, 2);
  assert.equal(
    await prisma.generationAttempt.count({ where: { status: "running" } }),
    2,
  );
  assert.equal(
    await prisma.generationAttempt.count({ where: { status: "queued" } }),
    1,
  );
  await setTimeout(550);
  await Promise.all([worker.tick(), second.tick()]);
  for (const created of [a, b, c]) {
    for (let i = 0; i < 100; i++) {
      if (
        (
          await prisma.generationAttempt.findUniqueOrThrow({
            where: { id: created.generationId },
          })
        ).status === "succeeded"
      )
        break;
      await setTimeout(10);
    }
  }
  assert.equal(calls, 3);
  await second.onModuleDestroy();
});

test("filesystem failures keep returned configs in DB without reporting success", async () => {
  const target = join(root, "target");
  await symlink(root, target);
  Object.assign(settings, { root: target });
  const created = (await create().expect(202)).body as CreateConfigResponse;
  await worker.tick();
  const result = await finished(created.generationId);
  assert.equal(result.error?.code, "STORAGE_FAILED");
  assert.equal(result.cleanupPending, true);
  assert.equal(await prisma.configRevision.count(), 0);
  assert.ok(
    (
      await prisma.generationAttempt.findUniqueOrThrow({
        where: { id: created.generationId },
      })
    ).outputEncrypted,
  );
});

test("compiler fixes executable arguments, escapes injected text and uses only the catalog", () => {
  assert.throws(() =>
    parseCandidate(
      JSON.stringify({
        schemaVersion: 1,
        services: [
          { ...input.services[0], image: "python" },
          input.services[1],
        ],
      }),
      input.services,
    ),
  );
  const compose = compileCompose(randomUUID(), randomUUID(), [
    { name: "python", type: "code", image: "python" },
    { name: "mongo", type: "database", image: "mongodb" },
  ]);
  assert.equal(compose.includes("Dockerfile"), false);
  assert.equal(compose.includes("privileged"), false);
  const document = JSON.parse(compose) as {
    services: Record<
      string,
      { command?: string[]; environment?: Record<string, string> }
    >;
  };
  assert.deepEqual(document.services.python!.command, [
    "python",
    "-m",
    "http.server",
    "8000",
    "--bind",
    "0.0.0.0",
  ]);
  assert.ok(
    document.services.mongo!.environment!.MONGO_INITDB_ROOT_PASSWORD!.startsWith(
      "${DIC_",
    ),
  );
});

test("all catalog templates pass actual Compose parsing without loading environment files", async () => {
  const compose = compileCompose(randomUUID(), randomUUID(), [
    { name: "node", type: "code", image: "node" },
    { name: "python", type: "code", image: "python" },
    { name: "db", type: "database", image: "mysql" },
    { name: "mongo", type: "database", image: "mongodb" },
  ]);
  const file = join(root, "compose.yaml");
  await writeFile(file, compose);
  execFileSync(
    "docker",
    [
      "compose",
      "--env-file",
      "/dev/null",
      "--project-directory",
      root,
      "-f",
      file,
      "config",
      "--quiet",
    ],
    {
      env: {
        PATH: process.env.PATH,
        COMPOSE_DISABLE_ENV_FILE: "1",
        DIC_DB_ROOT_PASSWORD: "test-only",
        DIC_DB_PASSWORD: "test-only",
        DIC_MONGO_ROOT_PASSWORD: "test-only",
      },
      timeout: 10000,
      stdio: "pipe",
    },
  );
});

test("expired worker leases are fenced and their known artifacts are recovered without regenerating", async () => {
  const created = (await create().expect(202)).body as CreateConfigResponse;
  await prisma.generationAttempt.update({
    where: { id: created.generationId },
    data: {
      status: "running",
      stage: "writing",
      leaseToken: randomUUID(),
      leaseExpiresAt: new Date(Date.now() - 1000),
    },
  });
  const file = await app
    .get(ArtifactStore)
    .write(auth.user.id, created.configId, created.generationId, "partial");
  let calls = 0;
  generate = async () => {
    calls++;
    return "unexpected";
  };
  await worker.tick();
  const result = await status(created.generationId);
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "INTERRUPTED");
  assert.equal(result.cleanupPending, false);
  assert.equal(calls, 0);
  await assert.rejects(stat(join(root, file)), { code: "ENOENT" });
});

test("graceful shutdown records an interrupted generation before closing database pools", async () => {
  generate = async (_input, signal) => {
    await setTimeout(60000, undefined, { signal });
    return "late";
  };
  const created = (await create().expect(202)).body as CreateConfigResponse;
  await worker.tick();
  assert.equal((await status(created.generationId)).status, "running");
  await app.close();
  await start();
  const result = await status(created.generationId);
  assert.equal(result.status, "failed");
  assert.equal(result.error?.code, "INTERRUPTED");
  assert.equal(
    await prisma.generationSlot.count({
      where: { generationId: created.generationId },
    }),
    0,
  );
});
