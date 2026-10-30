import { BadRequestException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import type { ConfigServiceInput } from "@docker-image-creator/contracts";
import { ConfigServiceDto } from "./config.dto";

export const CATALOG = {
  node: { image: "node:22.23.4-bookworm-slim", port: 8000 },
  python: { image: "python:3.13.18-slim-bookworm", port: 8000 },
  mysql: { image: "mysql:8.4.11", port: 3306 },
  mongodb: { image: "mongo:8.0.17", port: 27017 },
} as const;

export function validateServices(services: ConfigServiceInput[]): void {
  const names = new Set<string>();
  const ports = new Set<number>();
  for (const service of services) {
    const database = service.image === "mysql" || service.image === "mongodb";
    if (
      names.has(service.name) ||
      database !== (service.type === "database") ||
      (database && service.language !== undefined) ||
      (!database && service.database !== undefined) ||
      (service.language !== undefined &&
        service.language !==
          (service.image === "node" ? "javascript" : "python")) ||
      (service.hostPort !== undefined && ports.has(service.hostPort))
    ) {
      throw new BadRequestException(
        "Service settings conflict with the catalog",
      );
    }
    names.add(service.name);
    if (service.hostPort !== undefined) ports.add(service.hostPort);
  }
}

export function parseCandidate(
  raw: string,
  requested: ConfigServiceInput[],
): ConfigServiceInput[] {
  const value: unknown = JSON.parse(raw);
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid candidate");
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).sort().join(",") !== "schemaVersion,services" ||
    candidate.schemaVersion !== 1 ||
    !Array.isArray(candidate.services) ||
    candidate.services.length !== requested.length
  )
    throw new Error("Invalid candidate");
  const services: ConfigServiceInput[] = candidate.services.map(
    (entry: unknown) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry))
        throw new Error("Invalid service");
      const dto = plainToInstance(ConfigServiceDto, entry);
      if (
        validateSync(dto, {
          whitelist: true,
          forbidNonWhitelisted: true,
          forbidUnknownValues: true,
        }).length
      )
        throw new Error("Invalid service");
      return dto;
    },
  );
  validateServices(services);
  // The fake/first contract permits no unrequested services, settings, ports or images.
  if (
    JSON.stringify(services.map(canonical)) !==
    JSON.stringify(requested.map(canonical))
  )
    throw new Error("Candidate changed requested settings");
  return services;
}

function canonical(service: ConfigServiceInput) {
  return [
    service.name,
    service.type,
    service.image,
    service.language ?? null,
    service.hostPort ?? null,
    service.database ?? null,
  ];
}

export function secretNames(service: ConfigServiceInput): string[] {
  const prefix = `DIC_${service.name.toUpperCase().replaceAll("-", "_")}`;
  return service.image === "mysql"
    ? [`${prefix}_ROOT_PASSWORD`, `${prefix}_PASSWORD`]
    : service.image === "mongodb"
      ? [`${prefix}_ROOT_PASSWORD`]
      : [];
}

export function compileCompose(
  configId: string,
  revisionId: string,
  services: ConfigServiceInput[],
): string {
  const definitions: Record<string, unknown> = {};
  const volumes: Record<string, unknown> = {};
  for (const service of services) {
    const catalog = CATALOG[service.image];
    const definition: Record<string, unknown> = {
      image: catalog.image,
      init: true,
      restart: "no",
      networks: ["stack"],
      labels: {
        "docker-image-creator.config": configId,
        "docker-image-creator.revision": revisionId,
      },
      cpus: 0.5,
      mem_limit: "512m",
      pids_limit: 128,
      logging: {
        driver: "json-file",
        options: { "max-size": "5m", "max-file": "2" },
      },
    };
    if (service.hostPort !== undefined)
      definition.ports = [`127.0.0.1:${service.hostPort}:${catalog.port}`];
    const names = secretNames(service);
    const reference = (index: number) =>
      "${" +
      names[index] +
      ":?Required encrypted secret must be supplied by the runner}";
    if (service.image === "python") {
      definition.command = [
        "python",
        "-m",
        "http.server",
        "8000",
        "--bind",
        "0.0.0.0",
      ];
      definition.healthcheck = {
        test: [
          "CMD",
          "python",
          "-c",
          "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/', timeout=2).close()",
        ],
        interval: "5s",
        timeout: "3s",
        retries: 12,
      };
    } else if (service.image === "node") {
      definition.command = [
        "node",
        "-e",
        "require('node:http').createServer((_req,res)=>res.end('Starter ready\\n')).listen(8000,'0.0.0.0')",
      ];
      definition.healthcheck = {
        test: [
          "CMD",
          "node",
          "-e",
          "fetch('http://127.0.0.1:8000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
        ],
        interval: "5s",
        timeout: "3s",
        retries: 12,
      };
    } else {
      const volume = `${service.name}-data`;
      volumes[volume] = {};
      definition.volumes = [
        `${volume}:${service.image === "mysql" ? "/var/lib/mysql" : "/data/db"}`,
      ];
      definition.environment =
        service.image === "mysql"
          ? {
              MYSQL_ROOT_PASSWORD: reference(0),
              MYSQL_PASSWORD: reference(1),
              MYSQL_USER: "app",
              MYSQL_DATABASE: service.database ?? "app",
            }
          : {
              MONGO_INITDB_ROOT_USERNAME: "app",
              MONGO_INITDB_ROOT_PASSWORD: reference(0),
              MONGO_INITDB_DATABASE: service.database ?? "app",
            };
      // Authenticated database readiness probes are added with the private runner.
    }
    definitions[service.name] = definition;
  }
  // JSON is a YAML 1.2 subset accepted by Compose; quoting prevents YAML injection.
  return (
    JSON.stringify(
      {
        name: `dic-${configId}`,
        services: definitions,
        networks: { stack: { driver: "bridge" } },
        ...(Object.keys(volumes).length ? { volumes } : {}),
      },
      null,
      2,
    ) + "\n"
  );
}
