import {
  COMPOSE_GENERATION_MS,
  ComposeProviderFailure,
  ComposeValidationFailure,
  type ComposeGenerationProvider,
} from "../src/configs/compose.provider";
import { bodyLogDirectory } from "../src/configs/llm-body-log";
import { composeMessages } from "../src/configs/compose.prompt";
import { validateCompose } from "../src/configs/compose.validator";
import {
  RuntimeFailure,
  type RuntimeTarget,
} from "../src/runtime/runtime.driver";
import { CASES, prepareCase, type Probe } from "./cases";
import { pause, type EvaluationRuntime } from "./driver";
import {
  hash,
  newReport,
  score,
  type CaseResult,
  type EvaluationReport,
  type Reporter,
} from "./report";

const INFRA_CODES = new Set([
  "DOCKER_UNAVAILABLE",
  "UNSUPPORTED_DOCKER",
  "UNSUPPORTED_COMPOSE",
  "IMAGE_PULL_FAILED",
  "RESOURCE_CONFLICT",
  "INVALID_REVISION",
  "DELETE_FAILED",
  "STOP_FAILED",
]);
export function safeFailure(error: unknown): string {
  if (
    error instanceof ComposeProviderFailure ||
    error instanceof ComposeValidationFailure
  )
    return error.code;
  if (
    error instanceof RuntimeFailure &&
    (INFRA_CODES.has(error.code) ||
      ["START_FAILED", "CONTAINER_UNAVAILABLE"].includes(error.code))
  )
    return error.code;
  return "EVALUATOR_FAILURE";
}
interface EvaluationOptions {
  runId: string;
  provider: ComposeGenerationProvider;
  runtime: EvaluationRuntime;
  reporter: Reporter;
  signal: AbortSignal;
  /** Clock/wait injection for deterministic tests; CLI always uses real time. */
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export async function evaluate(
  options: EvaluationOptions,
): Promise<EvaluationReport> {
  const { provider, runtime, reporter, signal } = options;
  const now = options.now ?? (() => performance.now());
  const wait = options.wait ?? pause;
  const report = newReport(options.runId, provider.model);
  await reporter.checkpoint(report);
  await reporter.line(
    `Run ${report.runId}; ${report.model}; first response, no repair; ten cases. Preflight Docker/Compose and four pinned images.`,
  );
  await reporter.line(
    `Settings: ${JSON.stringify({ evaluatorVersion: report.evaluatorVersion, suiteVersion: report.suiteVersion, suiteDigest: report.suiteDigest, promptVersion: report.promptVersion, policy: report.policy, parameters: report.parameters })}`,
  );
  try {
    await runtime.preflight(
      AbortSignal.any([signal, AbortSignal.timeout(22 * 60000)]),
    );
    signal.throwIfAborted();
    report.preflight = "passed";
    await reporter.line("Preflight passed. No application database is used.");
  } catch (error) {
    report.preflight = "failed";
    report.failure = signal.aborted ? "INTERRUPTED" : safeFailure(error);
    await reporter.line(
      `Preflight failed: ${report.failure}; no inference scheduled.`,
    );
    if (report.failure === "PROVIDER_NOT_CONFIGURED")
      await reporter.line(
        "Supply OPENAI_BASE_URL, OPENAI_API_KEY and OPENAI_MODEL to the runner container before starting a fresh run. Recreate runner after updating its operator-managed Compose configuration; this CLI does not load environment files. Never include the key in a report.",
      );
    if (report.failure === "DOCKER_UNAVAILABLE")
      await reporter.line(
        "Run node dist-evaluation/evaluation/cli.js inside the existing runner container, which includes Docker CLI, Compose and /var/run/docker.sock. The application API container intentionally has no Docker access.",
      );
  }
  await reporter.checkpoint(report);
  if (report.preflight === "passed")
    for (let index = 0; index < CASES.length; index++) {
      if (signal.aborted) {
        report.failure = "INTERRUPTED";
        break;
      }
      const prepared = prepareCase(CASES[index]!);
      const row = report.cases[index]!;
      row.status = "running";
      row.identity = prepared.requirements.identity;
      row.llmLogDirectory = `llm/${bodyLogDirectory(row.identity)}`;
      row.promptDigest = hash(
        JSON.stringify(composeMessages(prepared.requirements)),
      );
      const started = now();
      let target: RuntimeTarget | undefined;
      try {
        row.stage = "generation";
        await reporter.line(`${row.id}: ${row.task}`);
        await reporter.checkpoint(report);
        const generationStarted = now();
        let result;
        try {
          result = await provider.generate(
            prepared.requirements,
            AbortSignal.any([
              signal,
              AbortSignal.timeout(COMPOSE_GENERATION_MS),
            ]),
          );
        } finally {
          row.generationMs = Math.round(now() - generationStarted);
        }
        signal.throwIfAborted();
        row.usage = result.usage;
        row.httpAttempts = result.httpAttempts;
        row.reportedModel = result.reportedModel;
        row.stage = "policy";
        const artifact = validateCompose(result.compose, prepared.requirements);
        row.policy = true;
        row.composeDigest = artifact.digest;
        target = {
          userId: prepared.requirements.identity.userId,
          configId: prepared.requirements.identity.configId,
          revisionId: prepared.requirements.identity.revisionId,
          services: prepared.requirements.services,
          requirements: prepared.requirements,
          metadata: artifact.metadata,
          manifest: artifact.compose,
          digest: artifact.digest,
          secrets: prepared.secrets,
        };
        row.volumes = [
          ...new Set(
            artifact.metadata.services.flatMap((service) =>
              service.volumes.map(
                (volume) =>
                  `${prepared.requirements.identity.projectName}_${volume.source}`,
              ),
            ),
          ),
        ];
        row.cleanup = "pending";
        row.stage = "startup";
        // A secret-free original artifact makes cleanup recoverable after hard termination.
        await reporter.saveArtifact(row.id, {
          requirements: prepared.requirements,
          artifact,
        });
        await reporter.line(
          `${row.id}: policy passed; starting the accepted document.`,
        );
        // Durable resource identities/volume names precede the first resource creation.
        await reporter.checkpoint(report);
        try {
          await runtime.launch(
            target,
            AbortSignal.any([signal, AbortSignal.timeout(8 * 60000)]),
          );
        } finally {
          Object.assign(row, runtime.startupTiming());
        }
        if (row.readinessMs! > 120000) throw new RuntimeFailure("START_FAILED");
        row.stage = "observation";
        const observationStarted = now();
        try {
          for (let second = 0; second <= 10; second++) {
            signal.throwIfAborted();
            if (!(await runtime.healthy(target, signal)))
              throw new RuntimeFailure("START_FAILED");
            if (second < 10) await wait(1000, signal);
          }
        } finally {
          row.observationMs = Math.round(now() - observationStarted);
        }
        row.healthy = true;
        row.stage = "assertions";
        await reporter.line(
          `${row.id}: healthy startup and ten-second observation passed.`,
        );
        await reporter.checkpoint(report);
        const runProbe = async (probe: Probe) => {
          signal.throwIfAborted();
          const assertion = row.assertions.find(
            (entry) => entry.id === probe.id,
          )!;
          assertion.passed = await runtime.probe(
            target!,
            prepared,
            probe,
            signal,
          );
          await reporter.line(
            `${row.id}: ${assertion.id}: ${assertion.passed ? "PASS" : "FAIL"}`,
          );
          await reporter.checkpoint(report);
          return assertion.passed;
        };
        for (const service of prepared.requirements.services)
          await runProbe({
            id: `${service.name}:environment`,
            kind: "environment",
            service: service.name,
          });
        for (const probe of prepared.definition.probes) await runProbe(probe);
        if (prepared.definition.persistence) {
          const persistence = prepared.definition.persistence;
          if (
            row.assertions.find(
              (entry) => entry.id === `${persistence}:write persistence marker`,
            )?.passed
          ) {
            const restartStarted = now();
            await runtime.stop(
              target,
              AbortSignal.any([signal, AbortSignal.timeout(150000)]),
            );
            // Same bytes, refs, values, revision and volumes; no further generation call.
            await runtime.launch(
              target,
              AbortSignal.any([signal, AbortSignal.timeout(8 * 60000)]),
            );
            row.restartMs = Math.round(now() - restartStarted);
            await runProbe({
              id: `${persistence}:row retained after Stop/Start`,
              service: persistence,
              kind: "mysql",
              mode: "retained",
            });
          }
        }
        if (prepared.definition.unavailable) {
          await runtime.stopService(
            target,
            prepared.definition.unavailable.database,
            signal,
          );
          await runProbe(prepared.definition.unavailable.probe);
        }
        row.taskSuccess = row.assertions.every(
          (assertion) => assertion.passed === true,
        );
        row.status = row.taskSuccess ? "passed" : "task_failed";
        if (!row.taskSuccess) row.failure = "ASSERTION_FAILED";
      } catch (error) {
        classify(row, error, signal, report);
      } finally {
        // Caller cancellation must never cancel cleanup. File-output errors also enter here.
        if (target) {
          try {
            await runtime.cleanup(target, AbortSignal.timeout(3 * 60000));
            row.cleanup = "passed";
          } catch {
            row.cleanup = "failed";
            report.failure = "CLEANUP_FAILED";
          }
        }
        for (const key of Object.keys(prepared.secrets))
          delete prepared.secrets[key];
        row.totalMs = Math.round(now() - started);
      }
      await reporter.line(`${row.id}: ${JSON.stringify(row)}`);
      await reporter.checkpoint(report);
      if (
        row.cleanup === "failed" ||
        ["infrastructure_error", "interrupted"].includes(row.status)
      )
        break;
    }
  report.finishedAt = new Date().toISOString();
  score(report);
  for (const row of report.cases.filter((row) => row.status === "not_run"))
    await reporter.line(`${row.id}: ${JSON.stringify(row)}`);
  await reporter.line(
    `Policy ${report.scores.policy}/10 (${report.scores.policyPercent}%); healthy ${report.scores.healthy}/10 (${report.scores.healthyPercent}%); task success ${report.scores.task}/10 (${report.scores.taskPercent}%).`,
  );
  if (report.preflight === "failed")
    await reporter.line(
      "No model score was measured: preflight failed and all ten cases remain not run. The zero counts above are not model-quality results.",
    );
  await reporter.line(
    `Complete: ${report.complete}; operationally successful: ${report.operationallySuccessful}; failure: ${report.failure ?? "none"}. Model failures have no minimum pass-rate gate.`,
  );
  await reporter.checkpoint(report);
  return report;
}

function classify(
  row: CaseResult,
  error: unknown,
  signal: AbortSignal,
  report: EvaluationReport,
): void {
  row.failure = signal.aborted ? "INTERRUPTED" : safeFailure(error);
  if (signal.aborted) {
    row.status = "interrupted";
    report.failure = "INTERRUPTED";
  } else if (
    error instanceof ComposeProviderFailure &&
    error.code === "PROVIDER_LOG_FAILED"
  ) {
    row.status = "infrastructure_error";
    report.failure = error.code;
  } else if (error instanceof ComposeProviderFailure)
    row.status =
      /^(OUTPUT_|PROVIDER_INVALID_RESPONSE|PROVIDER_MODEL_MISMATCH)/.test(
        error.code,
      )
        ? "invalid_output"
        : "provider_failure";
  else if (error instanceof ComposeValidationFailure) {
    row.status = "policy_rejected";
    row.policy = false;
  } else if (
    error instanceof RuntimeFailure &&
    ["START_FAILED", "CONTAINER_UNAVAILABLE"].includes(error.code)
  ) {
    row.status = row.stage === "assertions" ? "task_failed" : "startup_failed";
    if (row.stage !== "assertions") row.healthy = false;
  } else {
    row.status = "infrastructure_error";
    report.failure = row.failure;
  }
  if (row.status === "task_failed") row.taskSuccess = false;
}
