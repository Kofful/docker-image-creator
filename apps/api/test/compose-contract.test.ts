import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import type { ComposeRevisionMetadata } from "@docker-image-creator/contracts";
import {
  composeIdentity,
  ComposeRevisionFailure,
  readComposeRevisionCandidate,
} from "../src/configs/compose.revision";
import {
  COMPOSE_POLICY,
  COMPOSE_REVISION_HEADER,
  composeResourceLabels,
  composeServiceLabels,
} from "../src/configs/compose.policy";

const identity = composeIdentity(
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
);
const compose = readFileSync(
  resolve(__dirname, "../../test/fixtures/direct-compose.yaml"),
  "utf8",
);
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const metadata: ComposeRevisionMetadata = {
  ...COMPOSE_REVISION_HEADER,
  identity,
  services: [
    {
      name: "web",
      image: "node",
      imageReference: "node:22.23.4-bookworm-slim",
      containerPort: 8000,
      publishedPort: null,
      volumes: [],
    },
  ],
  environment: [
    {
      reference: "DIC_SECRET_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      purpose: "HTTP response message",
      bindings: [{ service: "web", name: "APP_MESSAGE" }],
    },
  ],
};

function rejects(value: unknown, code: string) {
  assert.throws(
    () =>
      readComposeRevisionCandidate(value, compose, digest(compose), identity),
    (error: unknown) =>
      error instanceof ComposeRevisionFailure && error.code === code,
  );
}

test("new artifact retains exact YAML bytes and digest without regeneration", () => {
  const result = readComposeRevisionCandidate(
    metadata,
    compose,
    digest(compose),
    identity,
  );
  assert.equal(result.compose, compose);
  assert.equal(result.digest, digest(compose));
  assert.deepEqual(result.identity, identity);
  assert.deepEqual(result.services, metadata.services);
});

test("legacy and unknown format/catalog/policy versions are unsupported", () => {
  for (const value of [
    null,
    [],
    {},
    { schemaVersion: 1, catalogVersion: 1, services: [] },
    { ...metadata, format: "template" },
    { ...metadata, schemaVersion: 1 },
    { ...metadata, schemaVersion: "2" },
    { ...metadata, policyVersion: "1" },
    { ...metadata, catalogVersion: 2 },
  ])
    rejects(value, "UNSUPPORTED_REVISION");
});

test("envelope rejects unknown or missing fields without exposing their contents", () => {
  rejects(
    { ...metadata, plaintextPassword: "private-test-value" },
    "INVALID_REVISION",
  );
  rejects({ ...COMPOSE_REVISION_HEADER, identity }, "INVALID_REVISION");
  rejects(
    { ...metadata, identity: { ...identity, hostPath: "/tmp" } },
    "INVALID_REVISION",
  );
  rejects({ ...metadata, identity: null }, "INVALID_REVISION");
  assert.throws(
    () =>
      readComposeRevisionCandidate(
        { ...metadata, value: "private-test-value" },
        compose,
        digest(compose),
        identity,
      ),
    (error: unknown) =>
      error instanceof Error && error.message === "INVALID_REVISION",
  );
});

test("artifact identities cannot cross user/config/revision/project boundaries", () => {
  for (const key of ["userId", "configId", "revisionId", "projectName"]) {
    rejects(
      { ...metadata, identity: { ...identity, [key]: "other" } },
      "REVISION_SCOPE_MISMATCH",
    );
  }
  assert.throws(
    () =>
      readComposeRevisionCandidate(metadata, compose, digest(compose), {
        ...identity,
        projectName: "other",
      }),
    { message: "REVISION_SCOPE_MISMATCH" },
  );
  assert.throws(
    () => composeIdentity("../unsafe", identity.configId, identity.revisionId),
    { message: "INVALID_REVISION" },
  );
});

test("integrity is byte-exact, including comments and trailing newline", () => {
  for (const candidate of [compose.trimEnd(), compose + "# modified\n"]) {
    assert.throws(
      () =>
        readComposeRevisionCandidate(
          metadata,
          candidate,
          digest(compose),
          identity,
        ),
      { message: "REVISION_DIGEST_MISMATCH" },
    );
  }
  for (const hash of ["", "g".repeat(64), digest(compose).toUpperCase()]) {
    assert.throws(
      () => readComposeRevisionCandidate(metadata, compose, hash, identity),
      { message: "REVISION_DIGEST_MISMATCH" },
    );
  }
});

test("empty and oversized artifacts fail before YAML parsing", () => {
  for (const candidate of [
    " \n",
    "é".repeat(COMPOSE_POLICY.maxOutputBytes / 2 + 1),
  ]) {
    assert.throws(
      () =>
        readComposeRevisionCandidate(
          metadata,
          candidate,
          digest(candidate),
          identity,
        ),
      { message: "INVALID_REVISION" },
    );
  }
});

test("format acceptance deliberately leaves YAML and derived metadata untrusted", () => {
  const malformed = "services: [invalid YAML";
  const result = readComposeRevisionCandidate(
    { ...metadata, services: "untrusted", environment: null },
    malformed,
    digest(malformed),
    identity,
  );
  assert.equal(result.services, "untrusted");
  assert.equal(result.environment, null);
  // This candidate is NOT an executable revision. Step 4 must validate the YAML.
  assert.equal(result.compose, malformed);
});

test("malformed persisted artifact fields return safe errors", () => {
  assert.throws(
    () =>
      readComposeRevisionCandidate(metadata, null, digest(compose), identity),
    { message: "INVALID_REVISION" },
  );
  assert.throws(
    () => readComposeRevisionCandidate(metadata, compose, null, identity),
    { message: "REVISION_DIGEST_MISMATCH" },
  );
});

test("ownership labels separate revision containers from retained network/volumes", () => {
  assert.deepEqual(composeResourceLabels(identity), {
    "docker-image-creator.managed": "runtime",
    "docker-image-creator.user": identity.userId,
    "docker-image-creator.config": identity.configId,
    "docker-image-creator.policy": "2",
  });
  assert.equal(
    composeServiceLabels(identity)["docker-image-creator.revision"],
    identity.revisionId,
  );
});
