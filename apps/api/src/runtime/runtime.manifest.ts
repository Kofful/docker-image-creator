import { createHash } from "node:crypto";
import type { ConfigServiceInput } from "@docker-image-creator/contracts";
import { compileCompose, parseCandidate } from "../configs/compose.compiler";

export const policyVersion = "1";
export const labelPrefix = "docker-image-creator";
export function runtimeLabels(userId: string, configId: string) {
  return {
    [`${labelPrefix}.managed`]: "runtime",
    [`${labelPrefix}.user`]: userId,
    [`${labelPrefix}.config`]: configId,
    [`${labelPrefix}.policy`]: policyVersion,
  };
}
export const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");

export function revisionServices(spec: unknown): ConfigServiceInput[] {
  if (!spec || typeof spec !== "object" || Array.isArray(spec))
    throw new Error("INVALID_REVISION");
  const row = spec as Record<string, unknown>;
  if (
    Object.keys(row).sort().join(",") !==
      "catalogVersion,schemaVersion,services" ||
    row.schemaVersion !== 1 ||
    row.catalogVersion !== 1 ||
    !Array.isArray(row.services) ||
    row.services.length < 1 ||
    row.services.length > 4
  )
    throw new Error("INVALID_REVISION");
  return parseCandidate(
    JSON.stringify({ schemaVersion: 1, services: row.services }),
    row.services,
  );
}

interface ComposeService {
  labels: Record<string, string>;
  healthcheck?: object;
  cap_drop?: string[];
  volumes?: string[];
}
export function runtimeManifest(
  userId: string,
  configId: string,
  revisionId: string,
  services: ConfigServiceInput[],
): string {
  const document = JSON.parse(
    compileCompose(configId, revisionId, services),
  ) as {
    services: Record<string, ComposeService>;
    networks: object;
    volumes?: Record<string, object>;
  };
  const labels = runtimeLabels(userId, configId);
  for (const service of services) {
    const definition = document.services[service.name]!;
    definition.labels = { ...definition.labels, ...labels };
    definition.cap_drop = ["NET_RAW"];
    if (service.image === "mysql")
      definition.healthcheck = {
        test: [
          "CMD-SHELL",
          'MYSQL_PWD="$${MYSQL_PASSWORD}" mysql --no-defaults --protocol=TCP -h 127.0.0.1 -u app "$${MYSQL_DATABASE}" -e "SELECT 1" >/dev/null 2>&1',
        ],
        interval: "5s",
        timeout: "5s",
        retries: 24,
        start_period: "10s",
      };
    if (service.image === "mongodb") {
      // The stock image also declares /data/configdb. Name and label it explicitly.
      const volume = `${service.name}-configdb`;
      document.volumes![volume] = { labels };
      definition.volumes!.push(`${volume}:/data/configdb`);
      definition.healthcheck = {
        test: [
          "CMD",
          "mongosh",
          "--quiet",
          "--eval",
          "const c=new Mongo('mongodb://127.0.0.1:27017'); const a=c.getDB('admin'); if(!a.auth(process.env.MONGO_INITDB_ROOT_USERNAME,process.env.MONGO_INITDB_ROOT_PASSWORD)) quit(1); if(!a.runCommand({ping:1}).ok) quit(1)",
        ],
        interval: "5s",
        timeout: "5s",
        retries: 24,
        start_period: "10s",
      };
    }
  }
  document.networks = {
    stack: {
      driver: "bridge",
      internal: true,
      enable_ipv6: false,
      driver_opts: {
        "com.docker.network.bridge.gateway_mode_ipv4": "isolated",
      },
      labels,
    },
  };
  for (const name of Object.keys(document.volumes ?? {}))
    document.volumes![name] = { labels };
  return JSON.stringify(document, null, 2) + "\n";
}
