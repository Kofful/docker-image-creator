import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ComposeGenerationRequirements } from "@docker-image-creator/contracts";
import { composeIdentity } from "../src/configs/compose.revision";

export const identity = composeIdentity(
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
);
export const fixture = (name: string) =>
  readFileSync(resolve(__dirname, "../../test/fixtures", name), "utf8");
export const reference = (char: string) => `DIC_SECRET_${char.repeat(32)}`;
export const nodeRequirements: ComposeGenerationRequirements = {
  inputVersion: 2,
  identity,
  services: [
    { name: "web", type: "web-server", image: "node", language: "javascript" },
  ],
  environment: [
    {
      reference: reference("a"),
      purpose: "HTTP response message",
      bindings: [{ service: "web", name: "APP_MESSAGE" }],
    },
  ],
};
export const allRequirements: ComposeGenerationRequirements = {
  inputVersion: 2,
  identity,
  services: [
    { name: "web", type: "web-server", image: "node" },
    { name: "py", type: "code", image: "python" },
    { name: "db", type: "database", image: "mysql", database: "app" },
    { name: "mongo", type: "database", image: "mongodb" },
  ],
  environment: [
    {
      reference: reference("a"),
      purpose: "MySQL root",
      bindings: [{ service: "db", name: "MYSQL_ROOT_PASSWORD" }],
    },
    {
      reference: reference("b"),
      purpose: "Shared app password",
      bindings: [
        { service: "db", name: "MYSQL_PASSWORD" },
        { service: "web", name: "APP_PASSWORD" },
      ],
    },
    {
      reference: reference("c"),
      purpose: "Mongo root",
      bindings: [{ service: "mongo", name: "MONGO_INITDB_ROOT_PASSWORD" }],
    },
  ],
};
