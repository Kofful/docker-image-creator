import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ComposeGenerationRequirements } from "@docker-image-creator/contracts";
import {
  CASES,
  prepareCase,
  suppliedValue,
  type PreparedCase,
  type Probe,
} from "../evaluation/cases";
import { FileLlmBodyLogger } from "../src/configs/llm-body-log";
import { OpenAICompatibleGenerationProvider } from "../src/configs/openai-compatible.provider";
import { evaluate } from "../evaluation/evaluator";
import { recover } from "../evaluation/recovery";
import {
  FileReporter,
  type EvaluationReport,
  type Reporter,
  type RecoveryArtifact,
} from "../evaluation/report";
import type { EvaluationRuntime } from "../evaluation/driver";
import {
  ComposeGenerationProvider,
  ComposeProviderFailure,
  type ComposeProviderResult,
} from "../src/configs/compose.provider";
import {
  RuntimeFailure,
  type RuntimeTarget,
} from "../src/runtime/runtime.driver";
import { runtimeFixture } from "./runtime-fixtures";

const TEST_MODEL = "modal-served-model";

class Provider extends ComposeGenerationProvider {
  readonly model = TEST_MODEL;
  inputs: ComposeGenerationRequirements[] = [];
  behavior?: (
    index: number,
    input: ComposeGenerationRequirements,
    signal: AbortSignal,
  ) => string | void;
  async generate(
    input: ComposeGenerationRequirements,
    signal: AbortSignal,
  ): Promise<ComposeProviderResult> {
    const index = this.inputs.push(structuredClone(input)) - 1;
    const compose =
      this.behavior?.(index, input, signal) ??
      runtimeFixture(input.identity, input.services, input.environment)
        .manifest;
    return {
      compose,
      provider: "openai" as const,
      model: TEST_MODEL,
      reportedModel: TEST_MODEL,
      elapsedMs: 10,
      httpAttempts: 2,
      usage: { totalTokens: 30 },
    };
  }
}
class Runtime implements EvaluationRuntime {
  launches: { digest: string; manifest: string; configId: string }[] = [];
  cleanups: string[] = [];
  values: string[] = [];
  healthCalls = 0;
  preflightFailure?: Error;
  startupFailureAt?: number;
  failAssertion = false;
  cleanupFailure = false;
  onLaunch?: () => void;
  async preflight() {
    if (this.preflightFailure) throw this.preflightFailure;
  }
  async launch(target: RuntimeTarget) {
    this.launches.push({
      digest: target.digest,
      manifest: target.manifest,
      configId: target.configId,
    });
    this.values.push(...Object.values(target.secrets));
    this.onLaunch?.();
    if (this.startupFailureAt === this.launches.length)
      throw new RuntimeFailure("START_FAILED");
    return this.startupTiming();
  }
  startupTiming() {
    return { pullMs: 5, readinessMs: 20 };
  }
  async healthy() {
    this.healthCalls++;
    return true;
  }
  async probe(_target: RuntimeTarget, _prepared: PreparedCase, probe: Probe) {
    return !(this.failAssertion && probe.kind === "tcp");
  }
  async stopService() {}
  async stop() {}
  async cleanup(target: RuntimeTarget, signal: AbortSignal) {
    assert.equal(
      signal.aborted,
      false,
      "cleanup needs a fresh cancellation budget",
    );
    this.cleanups.push(target.configId);
    if (this.cleanupFailure) throw new Error("RAW_PRIVATE_CLEANUP_ERROR");
  }
}
class MemoryReporter implements Reporter {
  lines: string[] = [];
  snapshots: EvaluationReport[] = [];
  artifacts = new Map<string, RecoveryArtifact>();
  async saveArtifact(id: string, artifact: RecoveryArtifact) {
    this.artifacts.set(id, structuredClone(artifact));
  }
  async line(line: string) {
    this.lines.push(line);
  }
  async checkpoint(report: EvaluationReport) {
    this.snapshots.push(structuredClone(report));
  }
}
function harness() {
  const provider = new Provider(),
    runtime = new Runtime(),
    reporter = new MemoryReporter(),
    controller = new AbortController();
  let time = 0;
  return {
    provider,
    runtime,
    reporter,
    controller,
    run: (extra: Partial<Parameters<typeof evaluate>[0]> = {}) =>
      evaluate({
        runId: "test-run",
        provider,
        runtime,
        reporter,
        signal: controller.signal,
        now: () => time,
        wait: async (ms) => {
          time += ms;
        },
        ...extra,
      }),
  };
}

test("ten fixed tasks have valid complete private inputs, shared bindings and unchanged C09 special characters", () => {
  assert.deepEqual(
    CASES.map((c) => c.id),
    Array.from({ length: 10 }, (_, i) => `C${String(i + 1).padStart(2, "0")}`),
  );
  const prepared = CASES.map(prepareCase);
  assert.equal(
    new Set(prepared.map((c) => c.requirements.identity.configId)).size,
    10,
  );
  for (const entry of prepared)
    for (const secret of Object.values(entry.secrets))
      assert.equal(JSON.stringify(entry.requirements).includes(secret), false);
  for (const index of [4, 5]) {
    const entry = prepared[index]!;
    assert.ok(
      suppliedValue(entry, "web", "DB_PASSWORD") ===
        suppliedValue(
          entry,
          "db",
          index === 4 ? "MYSQL_PASSWORD" : "MONGO_INITDB_ROOT_PASSWORD",
        ),
      "Shared supplied-value comparison failed",
    );
  }
  const password = suppliedValue(prepared[8]!, "db", "MYSQL_PASSWORD");
  for (const character of ["$", "'", '"', "\\", " ", "#"])
    assert.ok(password.includes(character));
  assert.equal(prepared[8]!.definition.persistence, "db");
  assert.equal(
    suppliedValue(prepared[7]!, "sql", "MYSQL_PASSWORD") ===
      suppliedValue(prepared[7]!, "documents", "MONGO_INITDB_ROOT_PASSWORD"),
    false,
  );
});

test("baseline runs exactly ten requests; C09 reuses the exact artifact and scores all ten", async () => {
  const h = harness();
  const report = await h.run();
  assert.equal(h.provider.inputs.length, 10);
  assert.equal(h.runtime.launches.length, 11);
  assert.deepEqual(h.runtime.launches[8], h.runtime.launches[9]);
  assert.equal(h.runtime.healthCalls, 110);
  assert.equal(
    report.cases.every((row) => row.observationMs === 10000),
    true,
  );
  assert.deepEqual(report.scores, {
    denominator: 10,
    policy: 10,
    healthy: 10,
    task: 10,
    policyPercent: 100,
    healthyPercent: 100,
    taskPercent: 100,
  });
  assert.equal(report.operationallySuccessful, true);
  assert.equal(h.runtime.cleanups.length, 10);
  assert.equal(
    report.cases.every((row) => row.assertions.every((a) => a.passed)),
    true,
  );
  assert.equal(
    h.reporter.snapshots.some((snapshot) =>
      snapshot.cases.some(
        (row) => row.cleanup === "pending" && row.identity && row.volumes,
      ),
    ),
    true,
  );
  const output = JSON.stringify([
    report,
    h.reporter.lines,
    h.reporter.snapshots,
    [...h.reporter.artifacts.values()],
  ]);
  for (const value of h.runtime.values)
    assert.equal(
      output.includes(value),
      false,
      "report may not contain private supplied values",
    );
});

test("provider, invalid response, policy, startup and independent assertion failures remain distinct", async () => {
  const h = harness();
  h.provider.behavior = (index) => {
    if (index === 0) throw new ComposeProviderFailure("PROVIDER_RATE_LIMITED");
    if (index === 1) throw new ComposeProviderFailure("OUTPUT_TRUNCATED");
    if (index === 2) return "services: {}";
  };
  h.runtime.startupFailureAt = 1;
  h.runtime.failAssertion = true;
  const report = await h.run();
  assert.deepEqual(
    report.cases.slice(0, 5).map((row) => row.status),
    [
      "provider_failure",
      "invalid_output",
      "policy_rejected",
      "startup_failed",
      "task_failed",
    ],
  );
  assert.equal(report.scores.policy, 7);
  assert.equal(report.scores.healthy, 6);
  assert.equal(report.scores.task, 3); // C05/C06/C10 fail the trusted TCP probe.
  assert.equal(
    report.operationallySuccessful,
    true,
    "measured model failures do not invalidate a clean complete run",
  );
  assert.equal(h.runtime.cleanups.length, 7);
  assert.equal(
    report.cases[3]!.readinessMs,
    20,
    "retain timings on failed startup",
  );
});

test("preflight failure schedules no inference; all ten cases stay in the denominator", async () => {
  for (const failure of [
    new RuntimeFailure("UNSUPPORTED_DOCKER"),
    new RuntimeFailure("DOCKER_UNAVAILABLE"),
    new ComposeProviderFailure("PROVIDER_NOT_CONFIGURED"),
  ]) {
    const h = harness();
    h.runtime.preflightFailure = failure;
    const report = await h.run();
    assert.equal(h.provider.inputs.length, 0);
    assert.equal(report.cases.filter((c) => c.status === "not_run").length, 10);
    assert.equal(report.scores.denominator, 10);
    assert.equal(report.complete, false);
    assert.equal(
      h.reporter.lines.filter((line) => /^C\d\d:/.test(line)).length,
      10,
    );
    assert.ok(
      h.reporter.lines.some((line) =>
        line.includes("No model score was measured"),
      ),
    );
    assert.equal(
      h.reporter.lines.some((line) =>
        line.startsWith(
          "Supply OPENAI_BASE_URL, OPENAI_API_KEY and OPENAI_MODEL",
        ),
      ),
      failure.code === "PROVIDER_NOT_CONFIGURED",
    );
    assert.equal(
      h.reporter.lines.some((line) =>
        line.includes("inside the existing runner container"),
      ),
      failure.code === "DOCKER_UNAVAILABLE",
    );
  }
});

test("cleanup failure keeps recovery identities, stops scheduling and never claims a clean pass", async () => {
  const h = harness();
  h.runtime.cleanupFailure = true;
  const report = await h.run();
  assert.equal(h.provider.inputs.length, 1);
  assert.equal(report.cases[0]!.cleanup, "failed");
  assert.ok(report.cases[0]!.identity?.configId);
  assert.equal(report.cases[1]!.status, "not_run");
  assert.equal(report.scores.task, 1);
  assert.equal(report.scores.denominator, 10);
  assert.equal(report.failure, "CLEANUP_FAILED");
  assert.equal(report.complete, false);
  assert.equal(report.operationallySuccessful, false);
  assert.equal(JSON.stringify(report).includes("RAW_PRIVATE"), false);
});

test("interruption during generation retains earlier checkpoints and completed results", async () => {
  const h = harness();
  h.provider.behavior = (index) => {
    if (index === 1) {
      h.controller.abort();
      throw new Error("PRIVATE_RAW_ERROR");
    }
  };
  const report = await h.run();
  assert.deepEqual(
    report.cases.slice(0, 3).map((c) => c.status),
    ["passed", "interrupted", "not_run"],
  );
  assert.equal(report.scores.task, 1);
  assert.equal(h.runtime.cleanups.length, 1);
  assert.equal(report.complete, false);
  assert.equal(JSON.stringify(report).includes("PRIVATE_RAW_ERROR"), false);
});

test("interruption during startup still cleans up with an independent signal", async () => {
  const h = harness();
  h.runtime.onLaunch = () => h.controller.abort();
  const report = await h.run();
  assert.equal(report.cases[0]!.status, "interrupted");
  assert.equal(report.cases[0]!.cleanup, "passed");
  assert.equal(h.runtime.cleanups.length, 1);
  assert.equal(h.provider.inputs.length, 1);
});

test("ten-second health observation can fail despite successful Compose startup", async () => {
  const h = harness();
  let observations = 0;
  h.runtime.healthy = async () => ++observations !== 4;
  const report = await h.run();
  assert.equal(report.cases[0]!.status, "startup_failed");
  assert.equal(report.cases[0]!.healthy, false);
  assert.equal(
    report.cases[0]!.assertions.every((a) => a.passed === null),
    true,
  );
  assert.equal(report.scores.healthy, 9);
  assert.equal(h.runtime.cleanups.length, 10);
});

test("infrastructure failure aborts later cases without misclassifying bad Compose", async () => {
  const h = harness();
  h.runtime.launch = async () => {
    throw new RuntimeFailure("DOCKER_UNAVAILABLE");
  };
  const report = await h.run();
  assert.equal(report.cases[0]!.status, "infrastructure_error");
  assert.equal(report.cases[0]!.healthy, null);
  assert.equal(h.provider.inputs.length, 1);
  assert.equal(report.complete, false);
});

test("report write failure after admission still enters cleanup", async () => {
  const h = harness();
  let failed = false;
  h.reporter.line = async (line) => {
    if (!failed && line.includes(":environment: PASS")) {
      failed = true;
      throw new Error("private file error");
    }
  };
  const report = await h.run();
  assert.equal(h.runtime.cleanups.length, 1);
  assert.equal(report.cases[0]!.cleanup, "passed");
  assert.equal(report.cases[0]!.status, "infrastructure_error");
});

test("terminal output matches the flushed transcript; JSON checkpoints retain all cases and scores", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dic-evaluation-report-"));
  try {
    let output = "";
    const reporter = new FileReporter(directory, (line) => {
      output += line;
    });
    await reporter.initialize();
    const h = harness();
    const report = await h.run({ reporter });
    assert.equal(
      await readFile(join(directory, "terminal.log"), "utf8"),
      output,
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(directory, "results.json"), "utf8")),
      report,
    );
    await assert.rejects(
      reporter.initialize(),
      "a run directory cannot be silently reused",
    );
    for (const value of h.runtime.values)
      assert.equal(output.includes(value), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("partial file checkpoints and secret-free artifacts recover cleanup without inference or Start", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dic-evaluation-recovery-"));
  try {
    const reporter = new FileReporter(directory, () => {});
    await reporter.initialize();
    const h = harness();
    h.runtime.onLaunch = () => h.controller.abort();
    const report = await h.run({ reporter });
    report.cases[0]!.status = "running";
    report.cases[0]!.cleanup = "pending";
    await reporter.checkpoint(report); // Simulates termination before finally/checkpoint.
    const stored = JSON.parse(
      await readFile(join(directory, "results.json"), "utf8"),
    ) as EvaluationReport;
    assert.equal(stored.cases.length, 10);
    assert.equal(stored.cases[0]!.cleanup, "pending");
    const launches = h.runtime.launches.length,
      requests = h.provider.inputs.length;
    const recovered = await recover(
      directory,
      "test-run",
      h.runtime,
      reporter,
      new AbortController().signal,
    );
    assert.equal(recovered.cases[0]!.cleanup, "passed");
    assert.equal(recovered.cases[0]!.status, "interrupted");
    assert.equal(
      recovered.complete,
      false,
      "cleanup cannot invent unfinished measurements",
    );
    assert.equal(h.runtime.launches.length, launches);
    assert.equal(h.provider.inputs.length, requests);
    const output = await readFile(join(directory, "C01.artifact.json"), "utf8");
    for (const value of h.runtime.values)
      assert.equal(output.includes(value), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recovery revalidates the saved artifact/digest before touching Docker", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "dic-evaluation-recovery-reject-"),
  );
  try {
    const reporter = new FileReporter(directory, () => {});
    await reporter.initialize();
    const h = harness();
    h.runtime.onLaunch = () => h.controller.abort();
    const report = await h.run({ reporter });
    report.cases[0]!.cleanup = "pending";
    await reporter.checkpoint(report);
    const path = join(directory, "C01.artifact.json");
    const record = JSON.parse(await readFile(path, "utf8")) as RecoveryArtifact;
    record.artifact.compose += "\n# changed bytes";
    await writeFile(path, JSON.stringify(record));
    const cleanups = h.runtime.cleanups.length;
    const recovered = await recover(
      directory,
      "test-run",
      h.runtime,
      reporter,
      new AbortController().signal,
    );
    assert.equal(recovered.cases[0]!.cleanup, "failed");
    assert.equal(h.runtime.cleanups.length, cleanups);
    assert.equal(recovered.operationallySuccessful, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a healthy result after the 120-second startup deadline does not earn healthy-start credit", async () => {
  const h = harness();
  h.runtime.startupTiming = () => ({ pullMs: 5, readinessMs: 120001 });
  const report = await h.run();
  assert.equal(report.scores.policy, 10);
  assert.equal(report.scores.healthy, 0);
  assert.equal(report.scores.task, 0);
  assert.equal(
    report.cases.every(
      (row) => row.status === "startup_failed" && row.healthy === false,
    ),
    true,
  );
  assert.equal(h.runtime.cleanups.length, 10);
});

test("report records the configured provider model without credentials or endpoint URLs", async () => {
  const provider = new Provider();
  const runtime = new Runtime();
  const reporter = new MemoryReporter();
  const report = await evaluate({
    runId: "77777777-7777-4777-8777-777777777777",
    provider,
    runtime,
    reporter,
    signal: new AbortController().signal,
    wait: async () => {},
  });
  assert.equal(report.model, TEST_MODEL);
  assert.equal(report.parameters.model, TEST_MODEL);
  assert.equal("provider" in report.parameters, false);
  assert.equal("apiKey" in report.parameters, false);
  assert.equal("baseURL" in report.parameters, false);
});

test("body logging failure is an infrastructure failure and stops case scheduling", async () => {
  const provider = new Provider();
  provider.behavior = () => {
    throw new ComposeProviderFailure("PROVIDER_LOG_FAILED");
  };
  const runtime = new Runtime();
  const report = await evaluate({
    runId: "77777777-7777-4777-8777-777777777777",
    provider,
    runtime,
    reporter: new MemoryReporter(),
    signal: new AbortController().signal,
    wait: async () => {},
  });
  assert.equal(report.cases[0]?.status, "infrastructure_error");
  assert.equal(report.failure, "PROVIDER_LOG_FAILED");
  assert.equal(provider.inputs.length, 1);
  assert.equal(report.complete, false);
  assert.equal(runtime.launches.length, 0);
  assert.equal(
    report.cases[0]?.llmLogDirectory,
    `llm/${report.cases[0]?.identity?.userId}/${report.cases[0]?.identity?.configId}/${report.cases[0]?.identity?.revisionId}`,
  );
});

test("evaluation retains every request and policy-rejected response beside its file report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dic-evaluation-bodies-"));
  try {
    const reporter = new FileReporter(directory, () => {});
    await reporter.initialize();
    const provider = new OpenAICompatibleGenerationProvider({
      apiKey: "mock-evaluator-key",
      baseURL: "https://example.modal.run/v1",
      model: TEST_MODEL,
      bodyLog: new FileLlmBodyLogger(join(directory, "llm")),
      fetch: async () =>
        new Response(
          JSON.stringify({
            model: TEST_MODEL,
            choices: [
              {
                finish_reason: "stop",
                message: { role: "assistant", content: "forbidden: true" },
              },
            ],
          }),
        ),
    });
    const runtime = new Runtime();
    const report = await evaluate({
      runId: "77777777-7777-4777-8777-777777777777",
      provider,
      runtime,
      reporter,
      signal: new AbortController().signal,
      wait: async () => {},
    });
    assert.equal(report.complete, true);
    assert.equal(runtime.launches.length, 0);
    for (const row of report.cases) {
      assert.equal(row.status, "policy_rejected");
      const path = join(directory, row.llmLogDirectory!);
      const files = await readdir(path);
      assert.equal(files.length, 2);
      const response = JSON.parse(
        await readFile(
          join(path, files.find((file) => file.endsWith(".response.json"))!),
          "utf8",
        ),
      ) as { body: { choices: { message: { content: string } }[] } };
      assert.equal(
        response.body.choices[0]?.message.content,
        "forbidden: true",
      );
    }
    const terminal = await readFile(join(directory, "terminal.log"), "utf8");
    assert.ok(!terminal.includes("forbidden: true"));
    assert.ok(!terminal.includes("mock-evaluator-key"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
