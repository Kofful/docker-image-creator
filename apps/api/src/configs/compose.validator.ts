import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { isAlias, isMap, isScalar, isSeq, parseAllDocuments } from "yaml";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import {
  environmentInputError,
  type ComposeGenerationRequirements,
  type ComposeRevisionArtifact,
  type ComposeIdentity,
} from "@docker-image-creator/contracts";
import { ConfigServiceDto } from "./config.dto";
import { validateServices } from "./service.validation";
import {
  composeIdentity,
  readComposeRevisionCandidate,
  ComposeRevisionFailure,
} from "./compose.revision";
import {
  COMPOSE_POLICY as POLICY,
  COMPOSE_REVISION_HEADER,
  composeResourceLabels,
  composeServiceLabels,
} from "./compose.policy";
import {
  ComposeValidationFailure,
  type ComposeValidationCode,
} from "./compose.provider";

type Mapping = Record<string, unknown>;
function fail(code: ComposeValidationCode): never {
  throw new ComposeValidationFailure(code);
}
function map(value: unknown, code: ComposeValidationCode): Mapping {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value as Mapping;
}
function fields(
  value: unknown,
  allowed: readonly string[],
  code: ComposeValidationCode,
): Mapping {
  const result = map(value, code);
  if (Object.keys(result).some((key) => !allowed.includes(key)))
    fail("UNKNOWN_FIELD");
  return result;
}
function equal(
  actual: unknown,
  expected: unknown,
  code: ComposeValidationCode,
) {
  // Parsed mappings have null prototypes, so compare entries recursively.
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) fail(code);
    expected.forEach((value, i) => equal(actual[i], value, code));
  } else if (expected && typeof expected === "object") {
    const record = fields(actual, Object.keys(expected), code);
    if (Object.keys(record).length !== Object.keys(expected).length) fail(code);
    for (const [key, value] of Object.entries(expected))
      equal(record[key], value, code);
  } else if (actual !== expected) fail(code);
}

/** No aliases/tags/merge expansion, object coercion, defaults, or serialization. */
function parseYaml(compose: string): Mapping {
  try {
    if (
      !compose.trim() ||
      Buffer.byteLength(compose) > POLICY.maxOutputBytes ||
      /\0|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
        compose,
      ) ||
      /^\uFEFF?%/m.test(compose)
    )
      fail("INVALID_YAML");
    const docs = parseAllDocuments(compose, {
      version: "1.2",
      schema: "core",
      merge: false,
      strict: true,
      uniqueKeys: true,
      prettyErrors: false,
      logLevel: "silent",
    });
    if (docs.length !== 1 || docs[0]!.errors.length || docs[0]!.warnings.length)
      fail("INVALID_YAML");
    let count = 0;
    const convert = (node: unknown, depth: number): unknown => {
      if (++count > 20000 || depth > 64 || isAlias(node)) fail("INVALID_YAML");
      if (
        (isMap(node) || isSeq(node) || isScalar(node)) &&
        (node.anchor || node.tag)
      )
        fail("INVALID_YAML");
      if (isMap(node)) {
        const result: Mapping = Object.create(null) as Mapping;
        for (const pair of node.items) {
          const key = convert(pair.key, depth + 1);
          if (
            typeof key !== "string" ||
            key === "<<" ||
            Object.hasOwn(result, key)
          )
            fail("INVALID_YAML");
          result[key] = convert(pair.value, depth + 1);
        }
        return result;
      }
      if (isSeq(node))
        return node.items.map((item) => convert(item, depth + 1));
      if (isScalar(node)) {
        const value: unknown = node.value;
        if (
          typeof value === "string" &&
          /\0|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
            value,
          )
        )
          fail("INVALID_YAML");
        if (typeof value === "number" && !Number.isFinite(value))
          fail("INVALID_YAML");
        return value;
      }
      if (node === null) return null;
      fail("INVALID_YAML");
    };
    return map(convert(docs[0]!.contents, 0), "INVALID_YAML");
  } catch {
    fail("INVALID_YAML");
  }
}

/** Recheck trusted requirements when reading durable inputs or saved revisions. */
export function validateComposeRequirements(
  input: ComposeGenerationRequirements,
  expected: ComposeIdentity,
): void {
  try {
    equal(
      input.identity,
      composeIdentity(expected.userId, expected.configId, expected.revisionId),
      "IDENTITY_MISMATCH",
    );
    if (
      expected.projectName !== input.identity.projectName ||
      input.inputVersion !== 2 ||
      !Array.isArray(input.services) ||
      input.services.length < 1 ||
      input.services.length > 4
    )
      fail("IMAGE_MISMATCH");
    for (const service of input.services) {
      if (service.hostPort !== undefined) fail("PORT_POLICY");
      if (
        validateSync(plainToInstance(ConfigServiceDto, service), {
          whitelist: true,
          forbidNonWhitelisted: true,
          forbidUnknownValues: true,
        }).length
      )
        fail("IMAGE_MISMATCH");
    }
    validateServices(input.services);
    if (!Array.isArray(input.environment)) fail("ENVIRONMENT_POLICY");
    const seen = new Set<string>();
    for (const entry of input.environment) {
      if (
        !new RegExp(POLICY.interpolation.referencePattern).test(
          entry.reference,
        ) ||
        seen.has(entry.reference)
      )
        fail("ENVIRONMENT_POLICY");
      seen.add(entry.reference);
    }
    // Reuse completeness/assignment rules without reading any stored values.
    if (
      environmentInputError({
        inputVersion: 2,
        name: "validation",
        services: input.services,
        environmentValues: input.environment.map((entry, i) => ({
          key: `value_${i}`,
          value: "metadata-only",
          purpose: entry.purpose,
        })),
        environmentBindings: input.environment.flatMap((entry, i) =>
          entry.bindings.map((binding) => ({
            ...binding,
            valueKey: `value_${i}`,
          })),
        ),
      })
    )
      fail("ENVIRONMENT_POLICY");
  } catch (error) {
    if (error instanceof ComposeValidationFailure) throw error;
    fail("ENVIRONMENT_POLICY");
  }
}

function argumentsList(value: unknown, health: boolean): string[] {
  const code = health ? "HEALTH_POLICY" : "COMMAND_POLICY";
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.some((item) => typeof item !== "string" || item.includes("\0")) ||
    !value[0]?.trim()
  )
    fail(code);
  const args = value as string[];
  if (
    health &&
    !(
      (args[0] === "CMD" && args.length >= 2 && args[1]!.trim()) ||
      (args[0] === "CMD-SHELL" && args.length === 2 && args[1]!.trim())
    )
  )
    fail(code);
  for (const arg of args) {
    // Container dollars must be escaped. Never inject secrets into commands.
    if (arg.replaceAll("$$", "").includes("$")) fail("ENVIRONMENT_POLICY");
  }
  // Reject obvious dependency installers/downloaders, including split argument
  // arrays. Arbitrary in-image code remains untrusted, not a code sandbox.
  if (
    /\b(?:apt(?:-get)?|apk|yum|dnf|pip[3]?|npm|pnpm|yarn)\s+(?:[^;\n]*\s)?(?:install|add|ci)\b|\b(?:curl|wget)\b/i.test(
      args.join(" "),
    )
  )
    fail(code);
  return args;
}

/** Derives inspection metadata only; returns the original string byte-for-byte. */
export function validateCompose(
  compose: string,
  input: ComposeGenerationRequirements,
): ComposeRevisionArtifact {
  validateComposeRequirements(input, input.identity);
  const root = fields(
    parseYaml(compose),
    POLICY.allowedFields.document,
    "INVALID_YAML",
  );
  equal(root.name, input.identity.projectName, "IDENTITY_MISMATCH");
  const definitions = fields(
    root.services,
    input.services.map((service) => service.name),
    "IMAGE_MISMATCH",
  );
  if (Object.keys(definitions).length !== input.services.length)
    fail("IMAGE_MISMATCH");
  equal(
    root.networks,
    {
      stack: {
        ...POLICY.requiredNetworkSettings,
        labels: composeResourceLabels(input.identity),
      },
    },
    "NETWORK_POLICY",
  );
  const volumes: Mapping = {};
  const dependencies = new Map<string, string[]>();
  const services = input.services.map((service) => {
    const def = fields(
      definitions[service.name],
      POLICY.allowedFields.service,
      "IMAGE_MISMATCH",
    );
    const catalog = POLICY.catalog[service.image];
    equal(def.image, catalog.image, "IMAGE_MISMATCH");
    for (const [key, value] of Object.entries(POLICY.requiredServiceSettings))
      equal(def[key], value, "RESOURCE_POLICY");
    equal(
      def.labels,
      composeServiceLabels(input.identity),
      "IDENTITY_MISMATCH",
    );
    if (def.command !== undefined) argumentsList(def.command, false);
    const health = fields(
      def.healthcheck,
      POLICY.allowedFields.healthcheck,
      "HEALTH_POLICY",
    );
    for (const [key, value] of Object.entries(POLICY.healthcheck))
      equal(health[key], value, "HEALTH_POLICY");
    argumentsList(health.test, true);
    const environment: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >;
    if (service.image === "mysql")
      Object.assign(environment, {
        MYSQL_DATABASE: service.database ?? "app",
        MYSQL_USER: "app",
      });
    if (service.image === "mongodb")
      Object.assign(environment, {
        MONGO_INITDB_DATABASE: service.database ?? "app",
        MONGO_INITDB_ROOT_USERNAME: "app",
      });
    for (const entry of input.environment)
      for (const binding of entry.bindings)
        if (binding.service === service.name)
          environment[binding.name] = `\${${entry.reference}:?Required value}`;
    if (Object.keys(environment).length || def.environment !== undefined)
      equal(def.environment, environment, "ENVIRONMENT_POLICY");
    const mounts =
      service.image === "mysql" || service.image === "mongodb"
        ? POLICY.databaseMounts[service.image]
        : [];
    const derivedVolumes = mounts.map((mount) => ({
      source: `${service.name}-${mount.suffix}`,
      target: mount.target,
    }));
    for (const volume of derivedVolumes)
      volumes[volume.source] = {
        labels: composeResourceLabels(input.identity),
      };
    if (mounts.length)
      equal(
        def.volumes,
        derivedVolumes.map((volume) => ({
          type: "volume",
          ...volume,
          read_only: false,
        })),
        "STORAGE_POLICY",
      );
    else if (def.volumes !== undefined) fail("STORAGE_POLICY");
    const deps =
      def.depends_on === undefined
        ? {}
        : fields(
            def.depends_on,
            input.services
              .filter((other) => other.name !== service.name)
              .map((other) => other.name),
            "DEPENDENCY_POLICY",
          );
    for (const dep of Object.values(deps))
      equal(dep, { condition: "service_healthy" }, "DEPENDENCY_POLICY");
    dependencies.set(service.name, Object.keys(deps));
    return {
      name: service.name,
      image: service.image,
      imageReference: catalog.image,
      containerPort: catalog.port,
      publishedPort: null,
      volumes: derivedVolumes,
    };
  });
  if (Object.keys(volumes).length || root.volumes !== undefined)
    equal(root.volumes, volumes, "STORAGE_POLICY");
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const checkCycle = (name: string) => {
    if (visiting.has(name)) fail("DEPENDENCY_POLICY");
    if (visited.has(name)) return;
    visiting.add(name);
    for (const dep of dependencies.get(name) ?? []) checkCycle(dep);
    visiting.delete(name);
    visited.add(name);
  };
  for (const name of dependencies.keys()) checkCycle(name);
  return {
    compose,
    digest: createHash("sha256").update(compose).digest("hex"),
    metadata: {
      ...COMPOSE_REVISION_HEADER,
      identity: { ...input.identity },
      services,
      environment: input.environment.map((entry) => ({
        reference: entry.reference,
        purpose: entry.purpose,
        bindings: entry.bindings.map((binding) => ({
          service: binding.service,
          name: binding.name,
        })),
      })),
    },
  };
}

function canonicalEnvironment(
  environment: ComposeGenerationRequirements["environment"],
) {
  return environment
    .map((entry) => ({
      ...entry,
      bindings: [...entry.bindings].sort((a, b) =>
        `${a.service}:${a.name}`.localeCompare(`${b.service}:${b.name}`),
      ),
    }))
    .sort((a, b) => a.reference.localeCompare(b.reference));
}

/** Re-derive and compare metadata; a matching digest/header is insufficient. */
export function validateSavedCompose(
  metadata: unknown,
  compose: unknown,
  digest: unknown,
  input: ComposeGenerationRequirements,
): ComposeRevisionArtifact {
  const candidate = readComposeRevisionCandidate(
    metadata,
    compose,
    digest,
    input.identity,
  );
  const artifact = validateCompose(candidate.compose, input);
  if (
    !isDeepStrictEqual(artifact.metadata.services, candidate.services) ||
    !isDeepStrictEqual(
      canonicalEnvironment(artifact.metadata.environment),
      canonicalEnvironment(
        candidate.environment as ComposeGenerationRequirements["environment"],
      ),
    )
  )
    throw new ComposeRevisionFailure("INVALID_REVISION");
  return artifact;
}
