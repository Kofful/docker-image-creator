// Test-only parameterization of a frozen authored document; no production renderer.
import { randomBytes } from "node:crypto";
import { parse, stringify } from "yaml";
import type {
  ComposeIdentity,
  ConfigServiceInput,
  ComposeGenerationRequirements,
} from "@docker-image-creator/contracts";
import type { RuntimeTarget } from "../src/runtime/runtime.driver";
import { validateCompose } from "../src/configs/compose.validator";
import { fixture, identity as frozenIdentity } from "./compose-test-fixtures";

export function runtimeFixture(
  identity: ComposeIdentity,
  services: ConfigServiceInput[],
  environment?: ComposeGenerationRequirements["environment"],
): RuntimeTarget {
  const references =
    environment ??
    services.flatMap((service) =>
      (service.image === "mysql"
        ? ["MYSQL_ROOT_PASSWORD", "MYSQL_PASSWORD"]
        : service.image === "mongodb"
          ? ["MONGO_INITDB_ROOT_PASSWORD"]
          : []
      ).map((name) => ({
        reference: `DIC_SECRET_${randomBytes(16).toString("hex")}`,
        purpose: name,
        bindings: [{ service: service.name, name }],
      })),
    );
  const requirements: ComposeGenerationRequirements = {
    inputVersion: 2,
    identity,
    services,
    environment: references,
  };
  let text = fixture("direct-compose-all.yaml");
  for (const key of ["userId", "configId", "revisionId"] as const)
    text = text.replaceAll(frozenIdentity[key], identity[key]);
  const doc = parse(text) as {
    name: string;
    services: Record<string, Record<string, unknown>>;
    networks: object;
    volumes: Record<string, object>;
  };
  const source = doc.services;
  doc.services = {};
  const volumes: Record<string, object> = {};
  const names = { node: "web", python: "py", mysql: "db", mongodb: "mongo" };
  for (const service of services) {
    const definition = source[names[service.image]]!;
    delete definition.depends_on;
    delete definition.ports;
    const env: Record<string, string> = {};
    if (service.image === "mysql")
      Object.assign(env, {
        MYSQL_DATABASE: service.database ?? "app",
        MYSQL_USER: "app",
      });
    if (service.image === "mongodb")
      Object.assign(env, {
        MONGO_INITDB_DATABASE: service.database ?? "app",
        MONGO_INITDB_ROOT_USERNAME: "app",
      });
    for (const entry of references)
      for (const binding of entry.bindings)
        if (binding.service === service.name)
          env[binding.name] = `\${${entry.reference}:?Required value}`;
    delete definition.environment;
    if (Object.keys(env).length) definition.environment = env;
    for (const mount of (definition.volumes ?? []) as { source: string }[]) {
      const original = mount.source;
      mount.source = original.replace(
        `${names[service.image]}-`,
        `${service.name}-`,
      );
      volumes[mount.source] = doc.volumes[original]!;
    }
    doc.services[service.name] = definition;
  }
  delete (doc as { volumes?: object }).volumes;
  if (Object.keys(volumes).length) doc.volumes = volumes;
  const artifact = validateCompose(stringify(doc), requirements);
  return {
    userId: identity.userId,
    configId: identity.configId,
    revisionId: identity.revisionId,
    services,
    manifest: artifact.compose,
    digest: artifact.digest,
    metadata: artifact.metadata,
    requirements,
    secrets: Object.fromEntries(
      references.map((entry) => [
        entry.reference,
        entry.bindings.some((binding) =>
          [
            "MYSQL_ROOT_PASSWORD",
            "MYSQL_PASSWORD",
            "MONGO_INITDB_ROOT_PASSWORD",
          ].includes(binding.name),
        )
          ? `test-$value # ${entry.reference.slice(-8)}`
          : `test-$value'"\\\n ${entry.reference.slice(-8)}`,
      ]),
    ),
  };
}
