import { randomBytes, randomUUID } from "node:crypto";
import type {
  ConfigServiceInput,
  ComposeGenerationRequirements,
} from "@docker-image-creator/contracts";
import { composeIdentity } from "../src/configs/compose.revision";
import { validateComposeRequirements } from "../src/configs/compose.validator";

export const SUITE_VERSION = 1;
export const EVALUATOR_VERSION = 1;
export type Probe =
  | { id: string; service: string; kind: "environment" }
  | {
      id: string;
      service: string;
      kind: "http";
      path: string;
      message?: string;
      unavailable?: boolean;
    }
  | { id: string; service: string; kind: "tcp"; host: string; port: number }
  | {
      id: string;
      service: string;
      kind: "mysql";
      mode: "query" | "root" | "denied" | "write" | "retained";
    }
  | { id: string; service: string; kind: "mongodb"; denied?: boolean };
interface Binding {
  key: string;
  service: string;
  name: string;
  purpose: string;
}
export interface EvaluationCase {
  id: string;
  task: string;
  services: ConfigServiceInput[];
  bindings: Binding[];
  probes: Probe[];
  unavailable?: { database: string; probe: Probe };
  persistence?: string;
}
export interface PreparedCase {
  definition: EvaluationCase;
  requirements: ComposeGenerationRequirements;
  secrets: Record<string, string>;
}
const application = (
  name: string,
  image: "node" | "python",
): ConfigServiceInput => ({ name, image, type: "code" });
const database = (
  name: string,
  image: "mysql" | "mongodb",
  db = "orders",
): ConfigServiceInput => ({ name, image, type: "database", database: db });
const binding = (
  service: string,
  name: string,
  key = `${service}-${name}`,
): Binding => ({
  key,
  service,
  name,
  purpose:
    name === "APP_MESSAGE"
      ? "Disposable message served exactly as plain UTF-8 text"
      : `Supplied ${name}; do not invent or change this credential`,
});
const credentials = (service: string, mysql: boolean): Binding[] =>
  (mysql
    ? ["MYSQL_ROOT_PASSWORD", "MYSQL_PASSWORD"]
    : ["MONGO_INITDB_ROOT_PASSWORD"]
  ).map((name) => binding(service, name));
const http = (
  service: string,
  path: string,
  message?: string,
): Extract<Probe, { kind: "http" }> => ({
  id: `${service}:GET ${path}`,
  service,
  kind: "http",
  path,
  message,
});
const sql = (service: string): Probe[] =>
  (["query", "root", "denied"] as const).map((mode) => ({
    id: `${service}:mysql ${mode}`,
    service,
    kind: "mysql",
    mode,
  }));
const mongo = (service: string): Probe[] =>
  [false, true].map((denied) => ({
    id: `${service}:mongodb ${denied ? "denied" : "ping"}`,
    service,
    kind: "mongodb",
    denied,
  }));
const tcp = (service: string, host: string, port: number): Probe => ({
  id: `${service}:DNS/TCP ${host}:${port}`,
  service,
  kind: "tcp",
  host,
  port,
});
const httpTask =
  "Listen on 0.0.0.0:8000. GET /healthz returns 200; GET /message returns precisely the plain UTF-8 APP_MESSAGE, without a newline or JSON quoting.";
const sharedTask =
  "Listen on 0.0.0.0:8000. GET /healthz returns 200. GET /ready returns 200 only if resolving db and connecting to its database TCP port succeeds; return 503 if it fails, within two seconds. Use standard libraries, no database client dependency.";

/** Frozen workload inputs and evaluator-owned assertions; no expected Compose output. */
export const CASES: EvaluationCase[] = [
  {
    id: "C01",
    task: `Node.js HTTP service. ${httpTask}`,
    services: [application("web", "node")],
    bindings: [binding("web", "APP_MESSAGE")],
    probes: [http("web", "/healthz"), http("web", "/message", "APP_MESSAGE")],
  },
  {
    id: "C02",
    task: `Python HTTP service. ${httpTask}`,
    services: [application("web", "python")],
    bindings: [binding("web", "APP_MESSAGE")],
    probes: [http("web", "/healthz"), http("web", "/message", "APP_MESSAGE")],
  },
  {
    id: "C03",
    task: "MySQL: create orders database; app authenticates with supplied MYSQL_PASSWORD and can SELECT 1. Configure separate supplied root password. Reject incorrect passwords.",
    services: [database("db", "mysql")],
    bindings: credentials("db", true),
    probes: sql("db"),
  },
  {
    id: "C04",
    task: "MongoDB: configure app root user authenticating against admin using supplied password; configure orders database environment setting. Reject incorrect passwords.",
    services: [database("db", "mongodb")],
    bindings: credentials("db", false),
    probes: mongo("db"),
  },
  {
    id: "C05",
    task: `Node.js with MySQL orders database on db:3306. ${sharedTask} web.DB_PASSWORD and db.MYSQL_PASSWORD share one supplied value. Configure separate supplied root password.`,
    services: [application("web", "node"), database("db", "mysql")],
    bindings: [
      ...credentials("db", true),
      binding("web", "DB_PASSWORD", "db-MYSQL_PASSWORD"),
    ],
    probes: [http("web", "/ready"), tcp("web", "db", 3306), ...sql("db")],
    unavailable: {
      database: "db",
      probe: {
        ...http("web", "/ready"),
        id: "web:ready rejects unavailable db",
        unavailable: true,
      },
    },
  },
  {
    id: "C06",
    task: `Python with MongoDB orders on db:27017, app root authenticates against admin. ${sharedTask} web.DB_PASSWORD and db.MONGO_INITDB_ROOT_PASSWORD share one supplied value.`,
    services: [application("web", "python"), database("db", "mongodb")],
    bindings: [
      ...credentials("db", false),
      binding("web", "DB_PASSWORD", "db-MONGO_INITDB_ROOT_PASSWORD"),
    ],
    probes: [http("web", "/ready"), tcp("web", "db", 27017), ...mongo("db")],
    unavailable: {
      database: "db",
      probe: {
        ...http("web", "/ready"),
        id: "web:ready rejects unavailable db",
        unavailable: true,
      },
    },
  },
  {
    id: "C07",
    task: `Python backend: ${httpTask} Node.js gateway on 8000: GET /healthz returns 200; GET /backend fetches http://backend:8000/message over private DNS and returns its exact body. No host ports.`,
    services: [
      application("gateway", "node"),
      application("backend", "python"),
    ],
    bindings: [binding("backend", "APP_MESSAGE")],
    probes: [
      http("backend", "/message", "APP_MESSAGE"),
      { ...http("gateway", "/backend"), message: "backend:APP_MESSAGE" },
      http("gateway", "/healthz"),
    ],
  },
  {
    id: "C08",
    task: "MySQL sql creates orders with app user and supplied root/application passwords. MongoDB documents configures orders and app root on admin with its distinct supplied password. No host ports. Both reject wrong passwords.",
    services: [database("sql", "mysql"), database("documents", "mongodb")],
    bindings: [...credentials("sql", true), ...credentials("documents", false)],
    probes: [...sql("sql"), ...mongo("documents")],
  },
  {
    id: "C09",
    task: "MySQL db creates orders and app with the exact supplied password containing dollars, single/double quotes, backslashes, spaces and #. Configure supplied root password. Handle initialization/authentication robustly without reinterpreting supplied values. A row inserted by the evaluator must survive Stop/Start on the same artifact/volume.",
    services: [database("db", "mysql")],
    bindings: credentials("db", true),
    probes: [
      ...sql("db"),
      {
        id: "db:write persistence marker",
        service: "db",
        kind: "mysql",
        mode: "write",
      },
    ],
    persistence: "db",
  },
  {
    id: "C10",
    task: `All four services together. Node.js node and Python python: ${httpTask} Each application can resolve and reach sql:3306 and documents:27017. MySQL sql and MongoDB documents configure orders with app users (Mongo authSource admin), distinct supplied credentials.`,
    services: [
      application("node", "node"),
      application("python", "python"),
      database("sql", "mysql"),
      database("documents", "mongodb"),
    ],
    bindings: [
      binding("node", "APP_MESSAGE"),
      binding("python", "APP_MESSAGE"),
      ...credentials("sql", true),
      ...credentials("documents", false),
    ],
    probes: [
      http("node", "/healthz"),
      http("node", "/message", "APP_MESSAGE"),
      http("python", "/healthz"),
      http("python", "/message", "APP_MESSAGE"),
      ...sql("sql"),
      ...mongo("documents"),
      ...["node", "python"].flatMap((service) => [
        tcp(service, "sql", 3306),
        tcp(service, "documents", 27017),
      ]),
    ],
  },
];

export function prepareCase(definition: EvaluationCase): PreparedCase {
  const identity = composeIdentity(randomUUID(), randomUUID(), randomUUID());
  const secrets: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  const environment: ComposeGenerationRequirements["environment"] = [];
  for (const key of new Set(definition.bindings.map((entry) => entry.key))) {
    const entries = definition.bindings.filter((entry) => entry.key === key);
    const reference = `DIC_SECRET_${randomBytes(16).toString("hex")}`;
    const suffix = randomBytes(16).toString("hex");
    secrets[reference] = entries.some((entry) => entry.name === "APP_MESSAGE")
      ? `message $ ' " \\ #\n${suffix}`
      : definition.id === "C09" &&
          entries.some((entry) => entry.name === "MYSQL_PASSWORD")
        ? `test-$'"\\ # ${suffix}`
        : `test-$value # ${suffix}`;
    environment.push({
      reference,
      purpose: entries[0]!.purpose,
      bindings: entries.map(({ service, name }) => ({ service, name })),
    });
  }
  const requirements: ComposeGenerationRequirements = {
    inputVersion: 2,
    identity,
    services: structuredClone(definition.services),
    instructions: definition.task,
    environment,
  };
  validateComposeRequirements(requirements, identity);
  return { definition, requirements, secrets };
}

export function suppliedValue(
  prepared: PreparedCase,
  service: string,
  name: string,
): string {
  const reference = prepared.requirements.environment.find((entry) =>
    entry.bindings.some(
      (binding) => binding.service === service && binding.name === name,
    ),
  )?.reference;
  if (!reference || prepared.secrets[reference] === undefined)
    throw new Error("INVALID_CASE");
  return prepared.secrets[reference];
}
