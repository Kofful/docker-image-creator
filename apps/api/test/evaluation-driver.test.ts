import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { CASES, prepareCase } from "../evaluation/cases";
import { EvaluationDockerDriver } from "../evaluation/driver";
import { composeResourceLabels } from "../src/configs/compose.policy";
import { runtimeFixture } from "./runtime-fixtures";

class Driver extends EvaluationDockerDriver {
  calls: {
    args: string[];
    input?: string;
    secrets?: Record<string, string>;
  }[] = [];
  reply: (args: string[]) => string = () => "PASS";
  override async terminalContainer() {
    return "a".repeat(64);
  }
  protected override async command(
    args: string[],
    _signal: AbortSignal,
    input?: string,
    secrets?: Record<string, string>,
  ) {
    this.calls.push({ args, input, secrets });
    return this.reply(args);
  }
}
const signal = () => AbortSignal.timeout(30000);
function fixture(index: number) {
  const prepared = prepareCase(CASES[index]!);
  const target = runtimeFixture(
    prepared.requirements.identity,
    prepared.requirements.services,
    prepared.requirements.environment,
  );
  target.requirements = prepared.requirements;
  target.secrets = prepared.secrets;
  return { prepared, target };
}

test("every trusted probe keeps private values in stdin or in-memory comparisons, never arguments", async () => {
  const driver = new Driver();
  for (let index = 0; index < CASES.length; index++) {
    const { prepared, target } = fixture(index);
    for (const probe of prepared.definition.probes)
      assert.equal(await driver.probe(target, prepared, probe, signal()), true);
    const args = JSON.stringify(driver.calls.map((call) => call.args));
    for (const value of Object.values(target.secrets))
      assert.equal(args.includes(value), false);
  }
  assert.equal(
    driver.calls.some((call) => call.args.includes("--env")),
    false,
  );
  assert.equal(
    driver.calls.every(
      (call) => !call.secrets || !Object.keys(call.secrets).length,
    ),
    true,
  );
  assert.equal(
    driver.calls
      .filter((call) => call.args[0] === "exec")
      .every((call) => call.args[1] === "-i"),
    true,
  );
});

test("raw probe output is only compared to the exact sentinel, never treated as a pass", async () => {
  const { prepared, target } = fixture(0);
  const driver = new Driver();
  for (const output of ["FAIL", "PASS\nprivate", "private", ""]) {
    driver.reply = () => output;
    assert.equal(
      await driver.probe(
        target,
        prepared,
        prepared.definition.probes[0]!,
        signal(),
      ),
      false,
    );
  }
});

test("environment comparison preserves every special character and checks public database settings", async () => {
  const { prepared, target } = fixture(8);
  const driver = new Driver();
  const actual = prepared.requirements.environment.flatMap((entry) =>
    entry.bindings.map(
      (binding) => `${binding.name}=${prepared.secrets[entry.reference]}`,
    ),
  );
  actual.push("MYSQL_DATABASE=orders", "MYSQL_USER=app");
  driver.reply = () => JSON.stringify(actual);
  const probe = {
    id: "db:environment",
    kind: "environment" as const,
    service: "db",
  };
  assert.equal(await driver.probe(target, prepared, probe, signal()), true);
  driver.reply = () =>
    JSON.stringify(actual.map((value) => value.replaceAll("\\", "")));
  assert.equal(await driver.probe(target, prepared, probe, signal()), false);
  driver.reply = () =>
    JSON.stringify(actual.filter((value) => value !== "MYSQL_DATABASE=orders"));
  assert.equal(await driver.probe(target, prepared, probe, signal()), false);
});

test("preflight checks capabilities and all four pinned images before inference", async () => {
  const driver = new Driver();
  driver.reply = (args) =>
    args[0] === "info"
      ? JSON.stringify({
          ServerVersion: "28.1.1",
          OSType: "linux",
          MemoryLimit: true,
          CpuCfsQuota: true,
          PidsLimit: true,
        })
      : args[0] === "compose"
        ? "2.40.0"
        : "sha256:test";
  await driver.preflight(signal());
  assert.equal(
    driver.calls.filter((call) => call.args[0] === "pull").length,
    4,
  );
  assert.equal(
    driver.calls.some((call) => call.args.some((arg) => arg.includes(".env"))),
    false,
  );
  const unsupported = new Driver();
  unsupported.reply = () => JSON.stringify({ ServerVersion: "27.1.2" });
  await assert.rejects(unsupported.preflight(signal()), /UNSUPPORTED_DOCKER/);
  assert.equal(unsupported.calls.length, 1);
  const oldCompose = new Driver();
  oldCompose.reply = (args) =>
    args[0] === "info"
      ? JSON.stringify({
          ServerVersion: "28.1.1",
          OSType: "linux",
          MemoryLimit: true,
          CpuCfsQuota: true,
          PidsLimit: true,
        })
      : "2.20.0";
  await assert.rejects(oldCompose.preflight(signal()), /UNSUPPORTED_COMPOSE/);
  assert.equal(
    oldCompose.calls.some((call) => call.args[0] === "pull"),
    false,
  );
});

class CleanupDriver extends Driver {
  stopped = false;
  removed = false;
  override async stop() {
    this.stopped = true;
  }
  override async remove() {
    assert.equal(this.stopped, true);
    this.removed = true;
  }
  override async observe() {
    return { ready: false, running: false, services: [] };
  }
}
test("test-volume cleanup verifies labels and absence; a foreign label prevents deletion", async () => {
  for (const foreign of [false, true]) {
    const { target } = fixture(2);
    const driver = new CleanupDriver();
    const project = target.requirements.identity.projectName,
      volume = `${project}_db-data`;
    let deleted = false;
    driver.reply = (args) => {
      if (args[0] === "volume" && args[1] === "ls")
        return deleted ? "" : volume;
      if (args[0] === "volume" && args[1] === "inspect")
        return JSON.stringify({
          ...composeResourceLabels(target.requirements.identity),
          "com.docker.compose.project": foreign ? "unrelated" : project,
        });
      if (args[0] === "volume" && args[1] === "rm") {
        deleted = true;
        return volume;
      }
      return "";
    };
    if (foreign)
      await assert.rejects(
        driver.cleanup(target, signal()),
        /RESOURCE_CONFLICT/,
      );
    else await driver.cleanup(target, signal());
    assert.equal(driver.removed, true);
    assert.equal(deleted, !foreign);
  }
});

test("unexpected scoped volume names stop cleanup before any test data is removed", async () => {
  const { target } = fixture(2);
  const driver = new CleanupDriver();
  driver.reply = () => "unexpected-volume";
  await assert.rejects(driver.cleanup(target, signal()), /RESOURCE_CONFLICT/);
  assert.equal(
    driver.calls.some((call) => call.args[1] === "rm"),
    false,
  );
});
