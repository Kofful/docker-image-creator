import { open, constants } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { validateSavedCompose } from "../src/configs/compose.validator";
import { CASES, EVALUATOR_VERSION, SUITE_VERSION } from "./cases";
import type { EvaluationRuntime } from "./driver";
import {
  hash,
  type EvaluationReport,
  type RecoveryArtifact,
  type Reporter,
} from "./report";

async function readBounded(path: string): Promise<unknown> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 8 * 1024 * 1024)
      throw new Error("INVALID_REPORT");
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

/** Explicit cleanup only: never invokes a provider, pulls, starts, or regenerates. */
export async function recover(
  directory: string,
  runId: string,
  runtime: EvaluationRuntime,
  reporter: Reporter,
  signal: AbortSignal,
): Promise<EvaluationReport> {
  const report = (await readBounded(
    join(directory, "results.json"),
  )) as EvaluationReport;
  if (
    report.runId !== runId ||
    report.evaluatorVersion !== EVALUATOR_VERSION ||
    report.suiteVersion !== SUITE_VERSION ||
    report.suiteDigest !== hash(JSON.stringify(CASES)) ||
    report.mode !== "first-response-no-repair" ||
    !Array.isArray(report.cases) ||
    report.cases.length !== 10 ||
    report.cases.some((row, index) => row.id !== CASES[index]!.id)
  )
    throw new Error("INVALID_REPORT");
  await reporter.line(
    `Recovery for ${runId}: cleanup only, no inference or Start. Existing measurements are retained.`,
  );
  for (const row of report.cases) {
    if (!["pending", "failed"].includes(row.cleanup)) continue;
    signal.throwIfAborted();
    try {
      const record = (await readBounded(
        join(directory, `${row.id}.artifact.json`),
      )) as RecoveryArtifact;
      if (
        !isDeepStrictEqual(row.identity, record.requirements.identity) ||
        !isDeepStrictEqual(
          record.requirements.services,
          CASES.find((entry) => entry.id === row.id)!.services,
        )
      )
        throw new Error("INVALID_ARTIFACT");
      const artifact = validateSavedCompose(
        record.artifact.metadata,
        record.artifact.compose,
        record.artifact.digest,
        record.requirements,
      );
      if (artifact.digest !== row.composeDigest)
        throw new Error("INVALID_ARTIFACT");
      await runtime.cleanup(
        {
          userId: record.requirements.identity.userId,
          configId: record.requirements.identity.configId,
          revisionId: record.requirements.identity.revisionId,
          services: record.requirements.services,
          requirements: record.requirements,
          metadata: artifact.metadata,
          manifest: artifact.compose,
          digest: artifact.digest,
          secrets: {},
        },
        AbortSignal.timeout(3 * 60000),
      );
      row.cleanup = "passed";
    } catch {
      row.cleanup = "failed";
    }
    if (row.status === "running") {
      row.status = "interrupted";
      row.failure = "INTERRUPTED";
    }
    await reporter.line(`${row.id}: recovery cleanup ${row.cleanup}.`);
    await reporter.checkpoint(report);
    if (row.cleanup === "failed") break;
  }
  if (
    !report.cases.some((row) => ["pending", "failed"].includes(row.cleanup)) &&
    report.failure === "CLEANUP_FAILED"
  )
    delete report.failure;
  await reporter.line(
    `Recovery completed; pending cleanup: ${report.cases.some((row) => ["pending", "failed"].includes(row.cleanup))}.`,
  );
  await reporter.checkpoint(report);
  return report;
}
