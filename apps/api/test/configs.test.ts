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
  CreateComposeConfigRequest,
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
import { allRequirements, fixture, identity } from "./compose-test-fixtures";
import {
  ComposeGenerationProvider,
  COMPOSE_MODEL,
  ComposeProviderFailure,
  type ComposeProviderResult,
  type ComposeValidationCode,
} from "../src/configs/compose.provider";
import type {
  ComposeGenerationRequirements,
  ComposeRevisionMetadata,
} from "@docker-image-creator/contracts";
import { validateSavedCompose } from "../src/configs/compose.validator";
import { ComposeGenerator } from "../src/configs/compose.generator";
import { GenerationWorker } from "../src/configs/generation.worker";
import { SecretBox } from "../src/configs/secret-box";
import {
  compileCompose,
  parseCandidate,
} from "../src/configs/compose.compiler";
import { ArtifactStore } from "../src/configs/artifact.store";
import { ConfigArtifactCleanup } from "../src/configs/config-artifact-cleanup";

let app: INestApplication;
let prisma: PrismaService;
let worker: GenerationWorker;
let root: string;
let auth: AuthResponse;
let settings: GenerationSettings;
let generate: (input: GenerationInput, signal: AbortSignal) => Promise<string>;
let generateCompose: (
  input: ComposeGenerationRequirements,
  signal: AbortSignal,
  repair?: ComposeValidationCode,
) => Promise<ComposeProviderResult>;
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
    .overrideProvider(ComposeGenerationProvider)
    .useValue({
      generate: (
        value: ComposeGenerationRequirements,
        signal: AbortSignal,
        repair?: ComposeValidationCode,
      ) => generateCompose(value, signal, repair),
    })
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
  generateCompose = async () => {
    throw new ComposeProviderFailure("PROVIDER_NOT_CONFIGURED");
  };
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
async function finished(
  id: string,
  token = auth.access_token,
): Promise<GenerationResponse> {
  for (let attempt = 0; attempt < 150; attempt++) {
    const result = await status(id, token);
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
    app.get(ConfigArtifactCleanup),
    app.get(ComposeGenerator),
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
  await Promise.all([
    finished(a.generationId),
    finished(b.generationId, other.access_token),
  ]);
  // Publication and slot release finish after the provider returns. Wait for
  // that durable boundary instead of assuming the host commits within 550 ms.
  for (let index = 0; index < 100; index++) {
    if (
      !(await prisma.generationSlot.count({
        where: { generationId: { in: [a.generationId, b.generationId] } },
      }))
    )
      break;
    await setTimeout(10);
  }
  assert.equal(
    await prisma.generationSlot.count({
      where: { generationId: { in: [a.generationId, b.generationId] } },
    }),
    0,
  );
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

function deleteConfig(id: string, token = auth.access_token) {
  return request(app.getHttpServer())
    .delete(`/api/v1/configs/${id}`)
    .auth(token, { type: "bearer" });
}

test("deletion retains DB history and secrets, removes only owned files, hides reads and serializes repeat requests", async () => {
  const key = randomUUID();
  const created = (await create(input, auth.access_token, key).expect(202))
    .body as CreateConfigResponse;
  const other = await register();
  const untouched = (await create(input, other.access_token).expect(202))
    .body as CreateConfigResponse;
  await worker.tick();
  await finished(created.generationId);
  await finished(untouched.generationId, other.access_token);
  const revision = await prisma.configRevision.findUniqueOrThrow({
    where: { generationId: created.generationId },
  });
  const secrets = await prisma.configSecret.findMany({
    where: { configId: created.configId },
  });
  const responses = await Promise.all([
    deleteConfig(created.configId),
    deleteConfig(created.configId),
  ]);
  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [204, 404],
  );
  const deleted = await prisma.configuration.findUniqueOrThrow({
    where: { id: created.configId },
  });
  assert.ok(deleted.deletedAt);
  assert.equal(deleted.cleanupPending, false);
  assert.deepEqual(
    await prisma.configRevision.findUniqueOrThrow({
      where: { id: revision.id },
    }),
    revision,
  );
  assert.deepEqual(
    await prisma.configSecret.findMany({
      where: { configId: created.configId },
    }),
    secrets,
  );
  assert.equal(
    (
      await prisma.generationAttempt.findUniqueOrThrow({
        where: { id: created.generationId },
      })
    ).status,
    "succeeded",
  );
  await assert.rejects(stat(join(root, revision.artifactPath)), {
    code: "ENOENT",
  });
  const otherRevision = await prisma.configRevision.findUniqueOrThrow({
    where: { generationId: untouched.generationId },
  });
  assert.ok(await stat(join(root, otherRevision.artifactPath)));
  for (const path of [
    `/configs/${created.configId}`,
    created.statusUrl.replace("/api/v1", ""),
  ])
    await request(app.getHttpServer())
      .get(`/api/v1${path}`)
      .auth(auth.access_token, { type: "bearer" })
      .expect(404);
  assert.deepEqual(
    (
      await request(app.getHttpServer())
        .get("/api/v1/configs")
        .auth(auth.access_token, { type: "bearer" })
        .expect(200)
    ).body,
    [],
  );
  await create(input, auth.access_token, key).expect(400);
  await create({ ...input, name: "Changed" }, auth.access_token, key).expect(
    400,
  );
});

test("deletion rejects queued and running generation with 403 without changing the configuration", async () => {
  let release!: (value: string) => void;
  generate = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const created = (await create().expect(202)).body as CreateConfigResponse;
  await deleteConfig(created.configId).expect(403);
  await worker.tick();
  for (let i = 0; !release && i < 50; i++) await setTimeout(10);
  await deleteConfig(created.configId).expect(403);
  assert.equal(
    (
      await prisma.configuration.findUniqueOrThrow({
        where: { id: created.configId },
      })
    ).deletedAt,
    null,
  );
  release(JSON.stringify({ schemaVersion: 1, services: input.services }));
  assert.equal((await finished(created.generationId)).status, "succeeded");
  await deleteConfig(created.configId).expect(204);
});

test("deletion enforces ownership, authentication, origin, UUID validation and session revocation", async () => {
  const created = (await create().expect(202)).body as CreateConfigResponse;
  const other = await register();
  await request(app.getHttpServer())
    .delete(`/api/v1/configs/${created.configId}`)
    .expect(401);
  await deleteConfig(created.configId, other.access_token).expect(404);
  await deleteConfig(randomUUID()).expect(404);
  await deleteConfig("invalid").expect(400);
  await deleteConfig(created.configId)
    .set("Origin", "https://evil.example")
    .expect(403);
  await request(app.getHttpServer())
    .post("/api/v1/auth/logout")
    .auth(auth.access_token, { type: "bearer" })
    .expect(204);
  await deleteConfig(created.configId).expect(401);
  assert.equal(
    (
      await prisma.configuration.findUniqueOrThrow({
        where: { id: created.configId },
      })
    ).deletedAt,
    null,
  );
});

test("failed generation with no artifact can be deleted without creating directories", async () => {
  generate = async () => "invalid";
  const created = (await create().expect(202)).body as CreateConfigResponse;
  await worker.tick();
  assert.equal((await finished(created.generationId)).status, "failed");
  await deleteConfig(created.configId).expect(204);
  await assert.rejects(stat(join(root, auth.user.id)), { code: "ENOENT" });
  assert.equal(
    (
      await prisma.configuration.findUniqueOrThrow({
        where: { id: created.configId },
      })
    ).cleanupPending,
    false,
  );
});

test("cleanup failure still returns 204 and survives restart until safe file removal succeeds", async () => {
  const created = (await create().expect(202)).body as CreateConfigResponse;
  await worker.tick();
  await finished(created.generationId);
  const revision = await prisma.configRevision.findUniqueOrThrow({
    where: { generationId: created.generationId },
  });
  const alias = join(root, "symlink-root");
  await symlink(root, alias);
  Object.assign(settings, { root: alias });
  await deleteConfig(created.configId).expect(204);
  assert.ok(await stat(join(root, revision.artifactPath)));
  assert.equal(
    (
      await prisma.configuration.findUniqueOrThrow({
        where: { id: created.configId },
      })
    ).cleanupPending,
    true,
  );
  await deleteConfig(created.configId).expect(404);
  await app.close();
  await start();
  await worker.tick();
  assert.equal(
    (
      await prisma.configuration.findUniqueOrThrow({
        where: { id: created.configId },
      })
    ).cleanupPending,
    true,
  );
  Object.assign(settings, { root });
  await worker.tick();
  await assert.rejects(stat(join(root, revision.artifactPath)), {
    code: "ENOENT",
  });
  assert.equal(
    (
      await prisma.configuration.findUniqueOrThrow({
        where: { id: created.configId },
      })
    ).cleanupPending,
    false,
  );
  assert.equal(
    await prisma.configRevision.count({
      where: { configId: created.configId },
    }),
    1,
  );
});

test("deleting a configuration immediately frees capacity at the 20-configuration quota", async () => {
  const created = (await create().expect(202)).body as CreateConfigResponse;
  await worker.tick();
  await finished(created.generationId);
  await prisma.configuration.createMany({
    data: Array.from({ length: 19 }, () => ({
      id: randomUUID(),
      userId: auth.user.id,
      name: "Retained",
      description: "",
      services: [],
      requestKey: randomUUID(),
      inputDigest: "0".repeat(64),
    })),
  });
  await create().expect(409);
  await deleteConfig(created.configId).expect(204);
  await create().expect(202);
  assert.equal(
    await prisma.configuration.count({
      where: { userId: auth.user.id, deletedAt: null },
    }),
    20,
  );
  assert.equal(
    await prisma.configuration.count({ where: { userId: auth.user.id } }),
    21,
  );
});

test("deletion waits for file publication and removes the committed artifact", async (t) => {
  const files = app.get(ArtifactStore);
  const write = files.write.bind(files);
  let entered!: () => void;
  const writing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.mock.method(
    files,
    "write",
    async (...args: Parameters<ArtifactStore["write"]>) => {
      entered();
      await blocked;
      return write(...args);
    },
  );
  const created = (await create().expect(202)).body as CreateConfigResponse;
  await worker.tick();
  await writing;
  let responded = false;
  const deletion = deleteConfig(created.configId).then((response) => {
    responded = true;
    return response;
  });
  try {
    await setTimeout(40);
    assert.equal(responded, false);
  } finally {
    release();
  }
  assert.equal((await deletion).status, 204);
  await assert.rejects(stat(join(root, auth.user.id, created.configId)), {
    code: "ENOENT",
  });
  assert.equal(
    (
      await prisma.configuration.findUniqueOrThrow({
        where: { id: created.configId },
      })
    ).cleanupPending,
    false,
  );
});

test("persistent cleanup failures do not starve configurations beyond the first batch", async (t) => {
  const ids = Array.from({ length: 21 }, () => randomUUID()).sort();
  const healthy = ids[20]!;
  await prisma.configuration.createMany({
    data: ids.map((id) => ({
      id,
      userId: auth.user.id,
      name: "Deleted",
      description: "",
      services: [],
      requestKey: randomUUID(),
      inputDigest: "0".repeat(64),
      deletedAt: new Date(),
      cleanupPending: true,
    })),
  });
  const files = app.get(ArtifactStore);
  const remove = files.removeConfig.bind(files);
  t.mock.method(
    files,
    "removeConfig",
    async (userId: string, configId: string) => {
      if (configId !== healthy) throw new Error("Unavailable artifact");
      await remove(userId, configId);
    },
  );
  await worker.tick();
  await worker.tick();
  assert.equal(
    (await prisma.configuration.findUniqueOrThrow({ where: { id: healthy } }))
      .cleanupPending,
    false,
  );
  assert.equal(
    await prisma.configuration.count({ where: { cleanupPending: true } }),
    20,
  );
});

function suppliedInput(): CreateComposeConfigRequest {
  return {
    ...input,
    inputVersion: 2,
    environmentValues: [
      {
        key: "root",
        value: " root '$\\ #\nnext\rline 🙂 ",
        purpose: "Database administrator password",
      },
      {
        key: "app",
        value: ' app $pass \\"# ',
        purpose: "Shared application password",
      },
    ],
    environmentBindings: [
      { service: "db", name: "MYSQL_ROOT_PASSWORD", valueKey: "root" },
      { service: "db", name: "MYSQL_PASSWORD", valueKey: "app" },
      { service: "api", name: "PATH", valueKey: "app" },
      { service: "api", name: "DOCKER_HOST", valueKey: "app" },
    ],
  };
}

test("supplied inputs stay gated until generation and execution integration is ready", async () => {
  const options = await request(app.getHttpServer())
    .get("/api/v1/config-input-options")
    .auth(auth.access_token, { type: "bearer" })
    .expect(200);
  assert.deepEqual(options.body, { suppliedEnvironment: false });
  await request(app.getHttpServer())
    .get("/api/v1/config-input-options")
    .expect(401);
  await create(suppliedInput()).expect(503);
  assert.equal(await prisma.configuration.count(), 0);
});

test("supplied values are encrypted once with shared scoped bindings and value-free generation input", async () => {
  Object.assign(settings, { suppliedEnvironmentEnabled: true });
  const body = suppliedInput();
  const key = randomUUID();
  const created = (await create(body, auth.access_token, key).expect(202))
    .body as CreateConfigResponse;
  assert.deepEqual(
    (await create(body, auth.access_token, key).expect(202)).body,
    created,
  );
  await create(
    {
      ...body,
      environmentValues: body.environmentValues.map((value) => ({
        ...value,
        value: "changed",
      })),
    },
    auth.access_token,
    key,
  ).expect(409);
  const values = await prisma.suppliedEnvironmentValue.findMany({
    where: { configId: created.configId },
    include: { bindings: true },
  });
  assert.equal(values.length, 2);
  const box = app.get(SecretBox);
  for (const entry of body.environmentValues) {
    const stored = values.find((value) => value.purpose === entry.purpose)!;
    assert.match(stored.reference, /^DIC_SECRET_[a-f0-9]{32}$/);
    assert.equal(
      box.open(
        stored.valueEncrypted,
        `${created.configId}:${stored.reference}`,
      ),
      entry.value,
    );
    assert.throws(() =>
      box.open(stored.valueEncrypted, `${randomUUID()}:${stored.reference}`),
    );
    assert.equal(JSON.stringify(stored).includes(entry.value), false);
  }
  assert.equal(
    values.find(
      (value) => value.purpose === body.environmentValues[1]!.purpose,
    )!.bindings.length,
    3,
  );
  const job = await prisma.generationAttempt.findUniqueOrThrow({
    where: { id: created.generationId },
  });
  const providerInput = box.open(job.inputEncrypted, job.id);
  const parsed = JSON.parse(providerInput) as {
    inputVersion: number;
    environment: unknown[];
  };
  assert.equal(parsed.inputVersion, 2);
  assert.equal(parsed.environment.length, 2);
  assert.equal(providerInput.includes('"valueKey"'), false);
  assert.equal(providerInput.includes('"environmentValues"'), false);
  for (const entry of body.environmentValues)
    assert.equal(providerInput.includes(JSON.stringify(entry.value)), false);
  const config = await prisma.configuration.findUniqueOrThrow({
    where: { id: created.configId },
  });
  assert.equal(config.inputVersion, 2);
  assert.match(config.inputDigest, /^[a-f0-9]{64}$/);
  assert.notEqual(
    config.inputDigest,
    createHash("sha256").update(JSON.stringify(body)).digest("hex"),
  );
  assert.deepEqual(config.services, body.services);
  let calls = 0;
  generate = async () => {
    calls++;
    return "unexpected";
  };
  await worker.tick();
  assert.equal(
    calls,
    0,
    "Legacy worker must not process supplied-value inputs",
  );
  assert.equal((await status(created.generationId)).status, "queued");
  const other = await register();
  for (const path of [
    `/configs/${created.configId}`,
    `/generations/${created.generationId}`,
  ]) {
    await request(app.getHttpServer())
      .get(`/api/v1${path}`)
      .auth(other.access_token, { type: "bearer" })
      .expect(404);
    const response = await request(app.getHttpServer())
      .get(`/api/v1${path}`)
      .auth(auth.access_token, { type: "bearer" })
      .expect(200);
    for (const entry of body.environmentValues)
      assert.equal(response.text.includes(JSON.stringify(entry.value)), false);
    assert.equal(response.text.includes("valueEncrypted"), false);
  }
  const list = await request(app.getHttpServer())
    .get("/api/v1/configs")
    .auth(auth.access_token, { type: "bearer" })
    .expect(200);
  assert.equal(list.text.includes("environmentValues"), false);
  // The composite FK prevents accidental cross-configuration secret binding.
  await assert.rejects(
    prisma.serviceEnvironmentBinding.create({
      data: {
        id: randomUUID(),
        configId: randomUUID(),
        valueId: values[0]!.id,
        service: "api",
        name: "OTHER",
      },
    }),
  );
});

test("environment validation rejects incomplete, ambiguous, unsupported, and unversioned inputs before enqueue", async () => {
  Object.assign(settings, { suppliedEnvironmentEnabled: true });
  const good = suppliedInput();
  const invalid: object[] = [
    { ...good, environmentValues: undefined },
    { ...good, environmentBindings: undefined },
    { ...good, inputVersion: undefined },
    { ...good, environmentBindings: good.environmentBindings.slice(1) },
    {
      ...good,
      environmentValues: [...good.environmentValues, good.environmentValues[0]],
    },
    {
      ...good,
      environmentBindings: [
        ...good.environmentBindings,
        good.environmentBindings[0],
      ],
    },
    {
      ...good,
      environmentBindings: [
        ...good.environmentBindings,
        { service: "foreign", name: "TOKEN", valueKey: "root" },
      ],
    },
    {
      ...good,
      environmentBindings: [
        ...good.environmentBindings,
        { service: "api", name: "TOKEN", valueKey: "missing" },
      ],
    },
    ...["", "contains\0nul", "\ud800", "🙂".repeat(1025)].map((value) => ({
      ...good,
      environmentValues: [
        { ...good.environmentValues[0], value },
        good.environmentValues[1],
      ],
    })),
    {
      ...good,
      environmentValues: [
        { ...good.environmentValues[0], purpose: " " },
        good.environmentValues[1],
      ],
    },
    {
      ...good,
      environmentValues: [
        ...good.environmentValues,
        { key: "unused", value: "unused", purpose: "Not bound" },
      ],
    },
    {
      ...good,
      environmentBindings: [
        ...good.environmentBindings,
        { service: "api", name: "BAD-NAME", valueKey: "root" },
      ],
    },
  ];
  for (const body of invalid) {
    const response = await create(body).expect(400);
    for (const entry of good.environmentValues)
      assert.equal(response.text.includes(JSON.stringify(entry.value)), false);
  }
  assert.equal(await prisma.configuration.count(), 0);
  assert.equal(await prisma.suppliedEnvironmentValue.count(), 0);
});

function directInput(): CreateComposeConfigRequest {
  return {
    inputVersion: 2,
    name: "Direct model output",
    services: structuredClone(allRequirements.services),
    environmentValues: allRequirements.environment.map((entry, i) => ({
      key: `value_${i}`,
      purpose: entry.purpose,
      value: `private-test-value-${i}-'$\n#=é-\\`,
    })),
    environmentBindings: allRequirements.environment.flatMap((entry, i) =>
      entry.bindings.map((binding) => ({ ...binding, valueKey: `value_${i}` })),
    ),
  };
}
function directCaptures(encrypted: string, id: string): string[] {
  const encoded = JSON.parse(
    app.get(SecretBox).open(encrypted, id),
  ) as string[];
  return encoded.map((value) => Buffer.from(value, "base64").toString("utf8"));
}
function enableDirect() {
  Object.assign(settings, {
    suppliedEnvironmentEnabled: true,
    directComposeGenerationEnabled: true,
  });
  generate = async () => {
    throw new Error("Legacy generation must not run");
  };
}
function directYaml(input: ComposeGenerationRequirements): string {
  // Tests substitute only server-issued fixture identities/references; production
  // never creates YAML from these fixtures or from derived metadata.
  let raw = fixture("direct-compose-all.yaml");
  for (const key of ["userId", "configId", "revisionId"] as const)
    raw = raw.replaceAll(identity[key], input.identity[key]);
  for (const entry of allRequirements.environment) {
    const matching = input.environment.find(
      (value) => value.purpose === entry.purpose,
    )!;
    raw = raw.replaceAll(entry.reference, matching.reference);
  }
  return raw;
}
function providerResult(compose: string): ComposeProviderResult {
  return {
    compose,
    provider: "openrouter",
    model: COMPOSE_MODEL,
    reportedModel: COMPOSE_MODEL,
    elapsedMs: 10,
    httpAttempts: 1,
    usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
  };
}

test("direct generation persists exact model bytes, metadata and encrypted captures without generating secrets or starting Docker", async () => {
  enableDirect();
  const body = directInput();
  let raw = "";
  let calls = 0;
  let requirements!: ComposeGenerationRequirements;
  generateCompose = async (input) => {
    requirements = input;
    calls++;
    raw = directYaml(input);
    for (const value of body.environmentValues)
      assert.equal(
        JSON.stringify(input).includes(JSON.stringify(value.value)),
        false,
      );
    return providerResult(raw);
  };
  const key = randomUUID();
  const created = (await create(body, auth.access_token, key).expect(202))
    .body as CreateConfigResponse;
  assert.deepEqual(
    (await create(body, auth.access_token, key).expect(202)).body,
    created,
  );
  assert.equal((await status(created.generationId)).provider, "openrouter");
  await worker.tick();
  const result = await finished(created.generationId);
  assert.equal(result.status, "succeeded");
  assert.equal(result.model, COMPOSE_MODEL);
  assert.equal(result.runtimeValidation, "not_performed");
  assert.equal(calls, 1);
  const revision = await prisma.configRevision.findUniqueOrThrow({
    where: { generationId: created.generationId },
  });
  assert.equal(revision.compose, raw);
  assert.equal(await readFile(join(root, revision.artifactPath), "utf8"), raw);
  assert.equal(revision.digest, createHash("sha256").update(raw).digest("hex"));
  const artifact = validateSavedCompose(
    revision.spec,
    revision.compose,
    revision.digest,
    requirements,
  );
  assert.equal(artifact.metadata.services.length, 4);
  assert.equal(
    (revision.spec as unknown as ComposeRevisionMetadata).schemaVersion,
    2,
  );
  assert.equal(await prisma.configSecret.count(), 0);
  assert.equal(await prisma.runtimeOperation.count(), 0);
  assert.equal(await prisma.deployment.count(), 0);
  const job = await prisma.generationAttempt.findUniqueOrThrow({
    where: { id: created.generationId },
  });
  assert.deepEqual(directCaptures(job.outputEncrypted!, job.id), [raw]);
  assert.equal(job.outputEncrypted!.includes(raw), false);
  assert.deepEqual(job.providerResponses, [
    {
      provider: "openrouter",
      model: COMPOSE_MODEL,
      reportedModel: COMPOSE_MODEL,
      elapsedMs: 10,
      httpAttempts: 1,
      usage: { promptTokens: 100, completionTokens: 200, totalTokens: 300 },
    },
  ]);
  for (const value of body.environmentValues)
    assert.equal(
      JSON.stringify(revision).includes(JSON.stringify(value.value)),
      false,
    );
  const response = await request(app.getHttpServer())
    .get(`/api/v1/configs/${created.configId}`)
    .auth(auth.access_token, { type: "bearer" })
    .expect(200);
  assert.equal((response.body as ConfigResponse).revision!.compose, raw);
  assert.equal(response.text.includes("providerResponses"), false);
  assert.equal(response.text.includes("outputEncrypted"), false);
  const other = await register();
  await request(app.getHttpServer())
    .get(created.statusUrl)
    .auth(other.access_token, { type: "bearer" })
    .expect(404);
});

test("direct validation repairs once, retaining both encrypted responses and publishing only accepted bytes", async () => {
  enableDirect();
  let calls = 0;
  let accepted = "";
  const invalid = "services: [private-test-invalid";
  generateCompose = async (input, _signal, repair) => {
    calls++;
    assert.equal(repair, calls === 1 ? undefined : "INVALID_YAML");
    accepted = directYaml(input);
    return providerResult(calls === 1 ? invalid : accepted);
  };
  const created = (await create(directInput()).expect(202))
    .body as CreateConfigResponse;
  await worker.tick();
  assert.equal((await finished(created.generationId)).status, "succeeded");
  assert.equal(calls, 2);
  const job = await prisma.generationAttempt.findUniqueOrThrow({
    where: { id: created.generationId },
  });
  assert.deepEqual(directCaptures(job.outputEncrypted!, job.id), [
    invalid,
    accepted,
  ]);
  assert.equal((job.providerResponses as unknown[]).length, 2);
  assert.equal(
    (
      await prisma.configRevision.findUniqueOrThrow({
        where: { generationId: job.id },
      })
    ).compose,
    accepted,
  );
});

test("two invalid direct responses are captured encrypted and cannot publish revisions or artifacts", async () => {
  enableDirect();
  let calls = 0;
  const invalid = "private-invalid-model-output";
  generateCompose = async () => {
    calls++;
    return providerResult(invalid);
  };
  const created = (await create(directInput()).expect(202))
    .body as CreateConfigResponse;
  await worker.tick();
  assert.equal(
    (await finished(created.generationId)).error?.code,
    "INVALID_YAML",
  );
  assert.equal(calls, 2);
  const job = await prisma.generationAttempt.findUniqueOrThrow({
    where: { id: created.generationId },
  });
  assert.deepEqual(directCaptures(job.outputEncrypted!, job.id), [
    invalid,
    invalid,
  ]);
  assert.equal(await prisma.configRevision.count(), 0);
  await assert.rejects(stat(join(root, auth.user.id)), { code: "ENOENT" });
});

test("repair provider failures retain the first response and do not fall back to the compiler", async () => {
  enableDirect();
  let calls = 0;
  generateCompose = async () => {
    if (++calls === 2)
      throw new ComposeProviderFailure("PROVIDER_RATE_LIMITED");
    return providerResult("invalid");
  };
  const created = (await create(directInput()).expect(202))
    .body as CreateConfigResponse;
  await worker.tick();
  assert.equal(
    (await finished(created.generationId)).error?.code,
    "PROVIDER_RATE_LIMITED",
  );
  const job = await prisma.generationAttempt.findUniqueOrThrow({
    where: { id: created.generationId },
  });
  assert.deepEqual(directCaptures(job.outputEncrypted!, job.id), ["invalid"]);
  assert.equal(await prisma.configRevision.count(), 0);
});

test("direct provider configuration failure is explicit with no fallback", async () => {
  enableDirect();
  const created = (await create(directInput()).expect(202))
    .body as CreateConfigResponse;
  await worker.tick();
  assert.equal(
    (await finished(created.generationId)).error?.code,
    "PROVIDER_NOT_CONFIGURED",
  );
  assert.equal(await prisma.configRevision.count(), 0);
});

test("direct deadline fences a provider ignoring cancellation, including late captures", async () => {
  enableDirect();
  Object.assign(settings, { generationMs: 80 });
  let release!: () => void;
  generateCompose = async (input) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return providerResult(directYaml(input));
  };
  const created = (await create(directInput()).expect(202))
    .body as CreateConfigResponse;
  await worker.tick();
  assert.equal(
    (await finished(created.generationId)).error?.code,
    "GENERATION_TIMEOUT",
  );
  release();
  await setTimeout(40);
  assert.equal(await prisma.configRevision.count(), 0);
  assert.equal(
    (
      await prisma.generationAttempt.findUniqueOrThrow({
        where: { id: created.generationId },
      })
    ).outputEncrypted,
    null,
  );
});

test("direct publication cannot succeed after its lease is revoked", async () => {
  enableDirect();
  let release!: () => void;
  let entered = false;
  generateCompose = async (input) => {
    entered = true;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return providerResult(directYaml(input));
  };
  const created = (await create(directInput()).expect(202))
    .body as CreateConfigResponse;
  await worker.tick();
  for (let i = 0; !entered && i < 100; i++) await setTimeout(5);
  assert.equal(entered, true);
  await prisma.generationAttempt.update({
    where: { id: created.generationId },
    data: { leaseExpiresAt: new Date(Date.now() - 1000) },
  });
  await worker.tick();
  release();
  await setTimeout(60);
  assert.equal((await status(created.generationId)).status, "failed");
  assert.equal(await prisma.configRevision.count(), 0);
  await assert.rejects(
    stat(
      join(
        root,
        auth.user.id,
        created.configId,
        created.generationId,
        "compose.yaml",
      ),
    ),
    { code: "ENOENT" },
  );
});

test("direct jobs survive queue restart and completed publication does not call the provider twice", async () => {
  enableDirect();
  let calls = 0;
  generateCompose = async (input) => {
    calls++;
    return providerResult(directYaml(input));
  };
  const created = (await create(directInput()).expect(202))
    .body as CreateConfigResponse;
  await worker.onModuleDestroy();
  await app.close();
  await start();
  await worker.tick();
  assert.equal((await finished(created.generationId)).status, "succeeded");
  await worker.onModuleDestroy();
  await app.close();
  await start();
  await worker.tick();
  assert.equal(calls, 1);
  assert.equal((await status(created.generationId)).status, "succeeded");
});

test("direct input metadata must agree with stored scoped bindings before calling a provider", async () => {
  enableDirect();
  let calls = 0;
  generateCompose = async (input) => {
    calls++;
    return providerResult(directYaml(input));
  };
  const created = (await create(directInput()).expect(202))
    .body as CreateConfigResponse;
  await prisma.serviceEnvironmentBinding.deleteMany({
    where: { configId: created.configId, service: "web" },
  });
  await worker.tick();
  assert.equal(
    (await finished(created.generationId)).error?.code,
    "INVALID_INPUT",
  );
  assert.equal(calls, 0);
  assert.equal(await prisma.configRevision.count(), 0);
});

test("direct storage failure rolls back success and leaves no executable revision", async () => {
  enableDirect();
  generateCompose = async (input) => providerResult(directYaml(input));
  app.get(ArtifactStore).write = async () => {
    throw new Error("private-storage-exception");
  };
  const created = (await create(directInput()).expect(202))
    .body as CreateConfigResponse;
  await worker.tick();
  assert.equal(
    (await finished(created.generationId)).error?.code,
    "STORAGE_FAILED",
  );
  assert.equal(await prisma.configRevision.count(), 0);
});

test("direct oversized mock response is bounded and rejected without repair", async () => {
  enableDirect();
  let calls = 0;
  generateCompose = async () => {
    calls++;
    return providerResult("x".repeat(settings.maxOutputBytes + 100));
  };
  const created = (await create(directInput()).expect(202))
    .body as CreateConfigResponse;
  await worker.tick();
  assert.equal(
    (await finished(created.generationId)).error?.code,
    "OUTPUT_TOO_LARGE",
  );
  assert.equal(calls, 1);
  const job = await prisma.generationAttempt.findUniqueOrThrow({
    where: { id: created.generationId },
  });
  const captures = directCaptures(job.outputEncrypted!, job.id);
  assert.equal(Buffer.byteLength(captures[0]!), settings.maxOutputBytes);
  assert.equal(job.outputTruncated, true);
  assert.equal(await prisma.configRevision.count(), 0);
});

test("direct rejected control-character responses stay within encrypted database capture limits", async () => {
  enableDirect();
  Object.assign(settings, { generationMs: 5000 });
  const raw = "\0".repeat(settings.maxOutputBytes);
  generateCompose = async () => providerResult(raw);
  const created = (await create(directInput()).expect(202))
    .body as CreateConfigResponse;
  await worker.tick();
  assert.equal(
    (await finished(created.generationId)).error?.code,
    "INVALID_YAML",
  );
  const job = await prisma.generationAttempt.findUniqueOrThrow({
    where: { id: created.generationId },
  });
  assert.deepEqual(directCaptures(job.outputEncrypted!, job.id), [raw, raw]);
  assert.ok(Buffer.byteLength(job.outputEncrypted!) < 4 * 1024 * 1024);
});

test("direct publication checks the durable deadline as well as the lease", async () => {
  enableDirect();
  generateCompose = async (input) => {
    await prisma.generationAttempt.update({
      where: { id: input.identity.revisionId },
      data: { deadlineAt: new Date(Date.now() - 1) },
    });
    return providerResult(directYaml(input));
  };
  const created = (await create(directInput()).expect(202))
    .body as CreateConfigResponse;
  await worker.tick();
  assert.equal((await finished(created.generationId)).status, "failed");
  assert.equal(await prisma.configRevision.count(), 0);
  await assert.rejects(
    stat(
      join(
        root,
        auth.user.id,
        created.configId,
        created.generationId,
        "compose.yaml",
      ),
    ),
    { code: "ENOENT" },
  );
});

test("direct publication serializes with deletion and cannot revive a deleted config", async () => {
  enableDirect();
  generateCompose = async (input) => {
    await prisma.configuration.update({
      where: { id: input.identity.configId },
      data: { deletedAt: new Date() },
    });
    return providerResult(directYaml(input));
  };
  const created = (await create(directInput()).expect(202))
    .body as CreateConfigResponse;
  await worker.tick();
  for (let i = 0; i < 100; i++) {
    const job = await prisma.generationAttempt.findUniqueOrThrow({
      where: { id: created.generationId },
    });
    if (job.status === "failed") break;
    await setTimeout(5);
  }
  assert.equal(
    (
      await prisma.generationAttempt.findUniqueOrThrow({
        where: { id: created.generationId },
      })
    ).status,
    "failed",
  );
  assert.equal(await prisma.configRevision.count(), 0);
});

test("direct queue selection excludes legacy jobs at cutover and two workers claim a new job once", async () => {
  const legacy = (await create().expect(202)).body as CreateConfigResponse;
  const other = await register();
  enableDirect();
  let calls = 0;
  generateCompose = async (input) => {
    calls++;
    await setTimeout(30);
    return providerResult(directYaml(input));
  };
  const created = (await create(directInput(), other.access_token).expect(202))
    .body as CreateConfigResponse;
  const second = new GenerationWorker(
    prisma,
    app.get(GenerationProvider),
    settings,
    app.get(SecretBox),
    app.get(ArtifactStore),
    app.get(ConfigArtifactCleanup),
    app.get(ComposeGenerator),
  );
  try {
    await Promise.all([worker.tick(), second.tick()]);
    assert.equal(
      (await finished(created.generationId, other.access_token)).status,
      "succeeded",
    );
    assert.equal(calls, 1);
    assert.equal((await status(legacy.generationId)).status, "queued");
  } finally {
    await second.onModuleDestroy();
  }
});

test("accepted direct fixture parses with actual Compose using only explicit disposable interpolation", () => {
  execFileSync(
    "docker",
    [
      "compose",
      "--env-file",
      "/dev/null",
      "--project-directory",
      root,
      "-f",
      "-",
      "config",
      "--quiet",
    ],
    {
      input: fixture("direct-compose-all.yaml"),
      env: {
        PATH: process.env.PATH,
        COMPOSE_DISABLE_ENV_FILE: "1",
        ...Object.fromEntries(
          allRequirements.environment.map((entry) => [
            entry.reference,
            'disposable-$-quote-"-newline\nvalue',
          ]),
        ),
      },
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
});
