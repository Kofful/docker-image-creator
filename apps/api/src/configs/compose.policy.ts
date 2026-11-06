import type {
  ComposeIdentity,
  ComposeRevisionHeader,
} from "@docker-image-creator/contracts";
import { CATALOG } from "./image.catalog";

export const COMPOSE_REVISION_HEADER = {
  format: "llm-compose",
  schemaVersion: 2,
  policyVersion: "2",
  catalogVersion: 1,
} as const satisfies ComposeRevisionHeader;

/** Contract for prompting and validation; this does not render or patch Compose. */
export const COMPOSE_POLICY = {
  ...COMPOSE_REVISION_HEADER,
  catalog: CATALOG,
  maxOutputBytes: 1024 * 1024,
  maxServices: 4,
  requiredServiceSettings: {
    init: true,
    restart: "no",
    networks: ["stack"],
    cap_drop: ["NET_RAW"],
    cpus: 0.5,
    mem_limit: "512m",
    pids_limit: 128,
    logging: {
      driver: "json-file",
      options: { "max-size": "5m", "max-file": "2" },
    },
  },
  requiredNetworkSettings: {
    driver: "bridge",
    internal: true,
    enable_ipv6: false,
    driver_opts: {
      "com.docker.network.bridge.gateway_mode_ipv4": "isolated",
    },
  },
  allowedFields: {
    document: ["name", "services", "networks", "volumes"],
    service: [
      "image",
      "init",
      "restart",
      "networks",
      "labels",
      "cap_drop",
      "cpus",
      "mem_limit",
      "pids_limit",
      "logging",
      "command",
      "healthcheck",
      "depends_on",
      "environment",
      "volumes",
    ],
    network: ["driver", "internal", "enable_ipv6", "driver_opts", "labels"],
    volume: ["labels"],
    mount: ["type", "source", "target", "read_only"],
    healthcheck: ["test", "interval", "timeout", "retries", "start_period"],
    dependency: ["condition"],
  },
  databaseMounts: {
    mysql: [{ suffix: "data", target: "/var/lib/mysql" }],
    mongodb: [
      { suffix: "data", target: "/data/db" },
      { suffix: "configdb", target: "/data/configdb" },
    ],
  },
  healthcheck: {
    interval: "5s",
    timeout: "5s",
    retries: 24,
    start_period: "10s",
  },
  interpolation: {
    referencePattern: "^DIC_SECRET_[a-f0-9]{32}$",
    requiredMessage: "Required value",
  },
} as const;

export function composeResourceLabels(identity: ComposeIdentity) {
  return {
    "docker-image-creator.managed": "runtime",
    "docker-image-creator.user": identity.userId,
    "docker-image-creator.config": identity.configId,
    "docker-image-creator.policy": COMPOSE_POLICY.policyVersion,
  };
}

export function composeServiceLabels(identity: ComposeIdentity) {
  return {
    ...composeResourceLabels(identity),
    "docker-image-creator.revision": identity.revisionId,
  };
}
