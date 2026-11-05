import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { parse, stringify } from "yaml";
import {
  validateCompose,
  validateSavedCompose,
} from "../src/configs/compose.validator";
import { ComposeValidationFailure } from "../src/configs/compose.provider";
import {
  allRequirements,
  fixture,
  identity,
  nodeRequirements,
  reference,
} from "./compose-test-fixtures";

const compose = fixture("direct-compose.yaml");
const all = fixture("direct-compose-all.yaml");
type ObjectMap = Record<string, unknown>;
function object(value: unknown): ObjectMap {
  return value as ObjectMap;
}
function modified(
  path: string[],
  value?: unknown,
  remove = false,
  source = all,
): string {
  const doc: unknown = parse(source);
  let target = object(doc);
  for (const key of path.slice(0, -1)) target = object(target[key]);
  const last = path.at(-1)!;
  if (remove) delete target[last];
  else target[last] = value;
  return stringify(doc);
}
function rejected(raw: string, input = allRequirements) {
  assert.throws(
    () => validateCompose(raw, input),
    (error: unknown) =>
      error instanceof ComposeValidationFailure &&
      !error.message.includes("private-test-secret"),
  );
}
test("accepts frozen Node and four-image documents, preserving exact bytes and deriving metadata", () => {
  for (const [raw, input] of [
    [compose, nodeRequirements],
    [all, allRequirements],
  ] as const) {
    const artifact = validateCompose(raw, input);
    assert.equal(artifact.compose, raw);
    assert.equal(
      artifact.digest,
      createHash("sha256").update(raw).digest("hex"),
    );
    assert.deepEqual(artifact.metadata.identity, identity);
    assert.equal(artifact.metadata.services.length, input.services.length);
    assert.deepEqual(artifact.metadata.environment, input.environment);
    assert.deepEqual(
      validateSavedCompose(artifact.metadata, raw, artifact.digest, input),
      artifact,
    );
  }
  const metadata = validateCompose(all, allRequirements).metadata;
  assert.deepEqual(metadata.services[0]!.publishedPort, {
    host: "127.0.0.1",
    hostPort: 18080,
    containerPort: 8000,
  });
  assert.deepEqual(metadata.services[2]!.volumes, [
    { source: "db-data", target: "/var/lib/mysql" },
  ]);
  assert.equal(metadata.services[3]!.volumes.length, 2);
});

test("rejects malformed YAML, multiple docs, duplicates, fences and nonmapping roots safely", () => {
  for (const raw of [
    "",
    "  ",
    "[",
    "null",
    "[]",
    "private-test-secret",
    "services: {}\nservices: {}",
    compose + "---\nname: extra",
    "```yaml\n" + compose + "```",
    "\0" + compose,
    "\ud800" + compose,
    "x".repeat(1024 * 1024 + 1),
    "? [a,b]\n: c",
    "name: !!str value",
    "%YAML 1.1\n---\n" + compose,
    "%TAG !e! tag:example.com,2020:\n---\n" + compose,
  ])
    rejected(raw);
});

test("rejects aliases, unused anchors, merge keys, tags and deeply nested/large ASTs", () => {
  for (const raw of [
    compose.replace("[stack]", "&unused [stack]"),
    compose.replace("[stack]", "[*missing]"),
    compose.replace("[stack]", "!!seq [stack]"),
    compose.replace("[stack]", "!custom [stack]"),
    compose.replace("services:", "services:\n  <<: {}"),
    `a: ${"[".repeat(100)}0${"]".repeat(100)}`,
    `a: [${Array(20001).fill("0").join(",")}]`,
    compose.replace("0.5", ".nan"),
  ])
    rejected(raw);
});

const adversarial: [string[], unknown][] = [
  [["include"], "private-test-secret"],
  [["version"], "3"],
  [["x-hidden"], {}],
  [["services", "web", "privileged"], true],
  [["services", "web", "network_mode"], "host"],
  [["services", "web", "pid"], "host"],
  [["services", "web", "ipc"], "host"],
  [["services", "web", "devices"], ["/dev/sda"]],
  [["services", "web", "build"], "."],
  [["services", "web", "entrypoint"], ["sh"]],
  [["services", "web", "env_file"], "/private-test-secret"],
  [["services", "web", "profiles"], ["debug"]],
  [["services", "web", "post_start"], []],
  [["services", "web", "cap_add"], ["SYS_ADMIN"]],
  [["services", "web", "cap_drop"], []],
  [["services", "web", "image"], "node:latest"],
  [["name"], "other"],
  [["services", "web", "labels", "docker-image-creator.user"], "other"],
  [["services", "web", "labels", "extra"], "x"],
  [["services", "web", "networks"], ["default"]],
  [["networks", "stack", "external"], true],
  [["networks", "stack", "name"], "shared"],
  [["networks", "stack", "internal"], false],
  [["networks", "stack", "enable_ipv6"], true],
  [["networks", "stack", "driver"], "host"],
  [["networks", "stack", "driver_opts", "unexpected"], "x"],
  [["networks", "extra"], {}],
  [["volumes", "db-data", "external"], true],
  [["volumes", "db-data", "name"], "shared"],
  [["volumes", "db-data", "driver_opts"], {}],
  [["volumes", "extra"], {}],
  [
    ["services", "web", "volumes"],
    ["/var/run/docker.sock:/var/run/docker.sock"],
  ],
  [
    ["services", "db", "volumes"],
    [{ type: "bind", source: "/", target: "/var/lib/mysql", read_only: false }],
  ],
  [["services", "db", "volumes"], ["/var/lib/mysql"]],
  [
    ["services", "db", "volumes"],
    [{ type: "volume", source: "db-data", target: "/wrong", read_only: false }],
  ],
  [["services", "web", "ports"], ["0.0.0.0:18080:8000"]],
  [
    ["services", "web", "ports"],
    [{ target: 8000, published: 18080, host_ip: "127.0.0.1", protocol: "tcp" }],
  ],
  [
    ["services", "web", "ports"],
    [{ target: 8000, published: "18080", host_ip: "0.0.0.0", protocol: "tcp" }],
  ],
  [
    ["services", "py", "ports"],
    [
      {
        target: 8000,
        published: "18080",
        host_ip: "127.0.0.1",
        protocol: "tcp",
      },
    ],
  ],
  [["services", "web", "environment", "APP_PASSWORD"], "private-test-secret"],
  [
    ["services", "web", "environment", "APP_PASSWORD"],
    `\${${reference("a")}:?Required value}`,
  ],
  [["services", "web", "environment", "APP_PASSWORD"], `\${${reference("b")}}`],
  [
    ["services", "web", "environment", "APP_PASSWORD"],
    `\${${reference("b")}:-default}`,
  ],
  [["services", "web", "environment", "EXTRA"], "inherited"],
  [["services", "web", "environment"], ["APP_PASSWORD"]],
  [["services", "db", "environment", "MYSQL_USER"], "root"],
  [["services", "db", "environment", "MYSQL_DATABASE"], "unrequested"],
  [["services", "web", "command"], "sh -c command"],
  [["services", "web", "command"], []],
  [
    ["services", "web", "command"],
    ["node", null],
  ],
  [
    ["services", "web", "command"],
    ["sh", "-c", "echo $PATH"],
  ],
  [
    ["services", "web", "command"],
    ["sh", "-c", `echo \${${reference("b")}:?Required value}`],
  ],
  [
    ["services", "web", "command"],
    ["npm", "install", "express"],
  ],
  [
    ["services", "web", "command"],
    ["sh", "-c", "curl https://example.com"],
  ],
  [["services", "web", "healthcheck", "disable"], true],
  [["services", "web", "healthcheck", "test"], ["NONE"]],
  [
    ["services", "web", "healthcheck", "test"],
    ["CMD-SHELL", "true", "extra"],
  ],
  [["services", "web", "healthcheck", "test"], ["CMD"]],
  [["services", "web", "healthcheck", "interval"], "1h"],
  [["services", "web", "depends_on", "web"], { condition: "service_healthy" }],
  [
    ["services", "web", "depends_on", "foreign"],
    { condition: "service_healthy" },
  ],
  [["services", "web", "depends_on", "db", "restart"], true],
  [["services", "web", "depends_on", "db", "condition"], "service_started"],
  [["services", "db", "depends_on"], { web: { condition: "service_healthy" } }],
];
for (const [path, value] of adversarial)
  test(`rejects policy change at ${path.join(".")}: ${JSON.stringify(value)}`, () =>
    rejected(modified(path, value)));

for (const path of [
  ["services", "web", "init"],
  ["services", "web", "restart"],
  ["services", "web", "cap_drop"],
  ["services", "web", "cpus"],
  ["services", "web", "mem_limit"],
  ["services", "web", "pids_limit"],
  ["services", "web", "logging", "options", "max-file"],
  ["services", "web", "healthcheck"],
  ["services", "web", "ports"],
  ["services", "db", "volumes"],
  ["volumes", "db-data"],
  ["services", "db", "environment", "MYSQL_PASSWORD"],
  ["networks"],
  ["services", "py"],
])
  test(`rejects missing setting ${path.join(".")}`, () =>
    rejected(modified(path, undefined, true)));

test("every nested mapping rejects unknown fields, including mount/port/health/logging/dependency", () => {
  for (const path of [
    ["services", "db", "volumes", "0", "extra"],
    ["services", "web", "ports", "0", "extra"],
    ["services", "web", "healthcheck", "extra"],
    ["services", "web", "logging", "extra"],
    ["services", "web", "logging", "options", "extra"],
    ["volumes", "db-data", "labels", "extra"],
  ])
    rejected(modified(path, true));
});

test("metadata tampering and digest changes cannot authorize saved artifacts", () => {
  const artifact = validateCompose(all, allRequirements);
  const altered = structuredClone(artifact.metadata);
  altered.services[0]!.imageReference = "node:latest";
  for (const metadata of [
    altered,
    { ...artifact.metadata, environment: [] },
    {
      ...artifact.metadata,
      identity: { ...identity, userId: identity.configId },
    },
  ])
    assert.throws(() =>
      validateSavedCompose(metadata, all, artifact.digest, allRequirements),
    );
  assert.throws(() =>
    validateSavedCompose(
      artifact.metadata,
      all + "\n",
      artifact.digest,
      allRequirements,
    ),
  );
});

test("requirements completeness, identities, duplicate bindings and catalog selections are revalidated", () => {
  for (const mutate of [
    (input: typeof allRequirements) => {
      input.environment = [];
    },
    (input: typeof allRequirements) => {
      input.environment.push(input.environment[0]!);
    },
    (input: typeof allRequirements) => {
      input.environment[0]!.bindings.push(input.environment[0]!.bindings[0]!);
    },
    (input: typeof allRequirements) => {
      input.services[0]!.hostPort = 80;
    },
    (input: typeof allRequirements) => {
      input.services[1]!.name = input.services[0]!.name;
    },
    (input: typeof allRequirements) => {
      input.identity.projectName = "other";
    },
  ]) {
    const input = structuredClone(allRequirements);
    mutate(input);
    rejected(all, input);
  }
});

test("escaped invalid scalar Unicode/NUL is rejected after parsing", () => {
  for (const escaped of [String.raw`"\u0000"`, String.raw`"\uD800"`])
    rejected(
      compose.slice(0, compose.indexOf("    command:")) +
        `    command: [node, ${escaped}]\n` +
        compose.slice(compose.indexOf("    healthcheck:")),
      nodeRequirements,
    );
});

test("single-image subsets need no extra services, secrets or volumes", () => {
  for (const service of allRequirements.services) {
    const doc = object(parse(all));
    const definition = object(object(doc.services)[service.name]);
    delete definition.depends_on;
    doc.services = { [service.name]: definition };
    const requiredVolumes = Object.fromEntries(
      Object.entries(object(doc.volumes)).filter(([name]) =>
        name.startsWith(`${service.name}-`),
      ),
    );
    if (Object.keys(requiredVolumes).length) doc.volumes = requiredVolumes;
    else delete doc.volumes;
    const environment = allRequirements.environment
      .map((entry) => ({
        ...entry,
        bindings: entry.bindings.filter(
          (binding) => binding.service === service.name,
        ),
      }))
      .filter((entry) => entry.bindings.length);
    const raw = stringify(doc);
    assert.equal(
      validateCompose(raw, {
        ...allRequirements,
        services: [service],
        environment,
      }).compose,
      raw,
    );
  }
});

test("valid YAML formatting variations preserve bytes without normalization", () => {
  for (const raw of [
    compose.replaceAll("\n", "\r\n"),
    "---\n" + compose + "...\n",
    JSON.stringify(parse(compose)),
  ]) {
    assert.equal(validateCompose(raw, nodeRequirements).compose, raw);
  }
  rejected("\ufeff%YAML 1.1\n---\n" + compose, nodeRequirements);
});

test("container PATH, DOCKER_HOST and prototype-like names stay ordinary explicit bindings", () => {
  const input = structuredClone(nodeRequirements);
  const doc = object(parse(compose));
  const environment = object(object(object(doc.services).web).environment);
  for (const name of ["PATH", "DOCKER_HOST", "__proto__"]) {
    input.environment[0]!.bindings.push({ service: "web", name });
    Object.defineProperty(environment, name, {
      value: `\${${reference("a")}:?Required value}`,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  assert.equal(
    validateCompose(stringify(doc), input).metadata.environment[0]!.bindings
      .length,
    4,
  );
  assert.equal(Object.getPrototypeOf({}), Object.prototype);
});
