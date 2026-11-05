import { describe, expect, it } from "vitest";
import { environmentInputError } from "@docker-image-creator/contracts";
import type { CreateComposeConfigRequest } from "@docker-image-creator/contracts";

function input(value = "value"): CreateComposeConfigRequest {
  return {
    inputVersion: 2,
    name: "Test",
    services: [{ name: "app", image: "node", type: "code" }],
    environmentValues: [{ key: "shared", value, purpose: "Setting" }],
    environmentBindings: [{ service: "app", name: "PATH", valueKey: "shared" }],
  };
}

describe("environment completeness and bounds", () => {
  it("accepts exact whitespace, quotes, dollar signs, backslashes, multiline and Unicode", () => {
    for (const value of [
      " ",
      " $money '\" \\ # ",
      "first\nsecond\rthird",
      "🙂".repeat(1024),
    ])
      expect(environmentInputError(input(value))).toBeNull();
  });
  it("rejects unsupported process values without including them in errors", () => {
    for (const value of [
      "",
      "x\0secret",
      "\ud800",
      "\udc00",
      "🙂".repeat(1025),
    ]) {
      const error = environmentInputError(input(value));
      expect(error).toContain("UTF-8 bytes");
      if (value) expect(error).not.toContain(value);
    }
  });
  it("bounds aggregate bytes and service assignments", () => {
    const request = input();
    request.environmentValues = Array.from({ length: 4 }, (_, index) => ({
      key: `key-${index}`,
      value: "a".repeat(4096),
      purpose: "Setting",
    }));
    request.environmentBindings = request.environmentValues.map((value) => ({
      service: "app",
      name: `ENV_${value.key.replace("-", "_")}`,
      valueKey: value.key,
    }));
    expect(environmentInputError(request)).toBeNull();
    request.environmentValues.push({
      key: "overflow",
      value: "x",
      purpose: "Setting",
    });
    expect(environmentInputError(request)).toContain("16384-byte");
    const many = input();
    many.environmentBindings = Array.from({ length: 33 }, (_, index) => ({
      service: "app",
      name: `ENV_${index}`,
      valueKey: "shared",
    }));
    expect(environmentInputError(many)).toContain("32 environment bindings");
  });
  it("checks required passwords for every database independently", () => {
    const request = input();
    request.services.push({
      name: "mongo",
      image: "mongodb",
      type: "database",
    });
    expect(environmentInputError(request)).toContain(
      "required database passwords",
    );
    request.environmentBindings.push({
      service: "mongo",
      name: "MONGO_INITDB_ROOT_PASSWORD",
      valueKey: "shared",
    });
    expect(environmentInputError(request)).toBeNull();
    request.services.push({ name: "db", image: "mysql", type: "database" });
    request.environmentBindings.push({
      service: "db",
      name: "MYSQL_ROOT_PASSWORD",
      valueKey: "shared",
    });
    expect(environmentInputError(request)).toContain(
      "required database passwords",
    );
    request.environmentBindings.push({
      service: "db",
      name: "MYSQL_PASSWORD",
      valueKey: "shared",
    });
    expect(environmentInputError(request)).toBeNull();
  });
});
