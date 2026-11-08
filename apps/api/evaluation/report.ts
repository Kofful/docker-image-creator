import { appendFile, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type {
  ComposeIdentity,
  ComposeGenerationRequirements,
  ComposeRevisionArtifact,
} from "@docker-image-creator/contracts";
import { COMPOSE_POLICY } from "../src/configs/compose.policy";
import { COMPOSE_PROMPT_VERSION } from "../src/configs/compose.prompt";
import { type ComposeProviderResult } from "../src/configs/compose.provider";
import { COMPLETION_PARAMETERS } from "../src/configs/openai-compatible.provider";
import { CASES, EVALUATOR_VERSION, SUITE_VERSION } from "./cases";

export type CaseStatus =
  | "not_run"
  | "running"
  | "passed"
  | "provider_failure"
  | "invalid_output"
  | "policy_rejected"
  | "startup_failed"
  | "task_failed"
  | "infrastructure_error"
  | "interrupted";
export interface CaseResult {
  id: string;
  task: string;
  status: CaseStatus;
  policy: boolean | null;
  healthy: boolean | null;
  taskSuccess: boolean | null;
  assertions: { id: string; passed: boolean | null }[];
  cleanup: "not_needed" | "pending" | "passed" | "failed";
  stage: string;
  failure?: string;
  identity?: ComposeIdentity;
  volumes?: string[];
  promptDigest?: string;
  llmLogDirectory?: string;
  composeDigest?: string;
  usage?: ComposeProviderResult["usage"];
  httpAttempts?: number;
  reportedModel?: string;
  generationMs?: number;
  pullMs?: number;
  readinessMs?: number;
  observationMs?: number;
  restartMs?: number;
  totalMs?: number;
}
export interface EvaluationReport {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  evaluatorVersion: number;
  suiteVersion: number;
  suiteDigest: string;
  promptVersion: number;
  policy: typeof COMPOSE_POLICY;
  parameters: typeof COMPLETION_PARAMETERS & { model: string };
  model: string;
  mode: "first-response-no-repair";
  preflight: "pending" | "passed" | "failed";
  failure?: string;
  complete: boolean;
  operationallySuccessful: boolean;
  cases: CaseResult[];
  scores: {
    denominator: 10;
    policy: number;
    healthy: number;
    task: number;
    policyPercent: number;
    healthyPercent: number;
    taskPercent: number;
  };
}
export const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");

export function newReport(
  runId: string,
  model = "unconfigured",
): EvaluationReport {
  return {
    runId,
    startedAt: new Date().toISOString(),
    evaluatorVersion: EVALUATOR_VERSION,
    suiteVersion: SUITE_VERSION,
    suiteDigest: hash(JSON.stringify(CASES)),
    promptVersion: COMPOSE_PROMPT_VERSION,
    policy: COMPOSE_POLICY,
    parameters: { ...COMPLETION_PARAMETERS, model },
    model,
    mode: "first-response-no-repair",
    preflight: "pending",
    complete: false,
    operationallySuccessful: false,
    cases: CASES.map((definition) => ({
      id: definition.id,
      task: definition.task,
      status: "not_run",
      policy: null,
      healthy: null,
      taskSuccess: null,
      assertions: [
        ...definition.services.map((service) => ({
          id: `${service.name}:environment`,
          passed: null,
        })),
        ...definition.probes.map((probe) => ({ id: probe.id, passed: null })),
        ...(definition.unavailable
          ? [{ id: definition.unavailable.probe.id, passed: null }]
          : []),
        ...(definition.persistence
          ? [
              {
                id: `${definition.persistence}:row retained after Stop/Start`,
                passed: null,
              },
            ]
          : []),
      ],
      cleanup: "not_needed",
      stage: "not_run",
    })),
    scores: {
      denominator: 10,
      policy: 0,
      healthy: 0,
      task: 0,
      policyPercent: 0,
      healthyPercent: 0,
      taskPercent: 0,
    },
  };
}
export function score(report: EvaluationReport): void {
  for (const [source, target] of [
    ["policy", "policy"],
    ["healthy", "healthy"],
    ["taskSuccess", "task"],
  ] as const) {
    const count = report.cases.filter((row) => row[source] === true).length;
    report.scores[target] = count;
    report.scores[`${target}Percent`] = count * 10;
  }
  report.complete =
    report.preflight === "passed" &&
    report.cases.every(
      (row) =>
        !["running", "not_run", "infrastructure_error", "interrupted"].includes(
          row.status,
        ),
    );
  report.operationallySuccessful =
    report.complete &&
    report.cases.every(
      (row) => row.cleanup === "not_needed" || row.cleanup === "passed",
    );
}
export interface Reporter {
  line(value: string): Promise<void>;
  checkpoint(report: EvaluationReport): Promise<void>;
  saveArtifact(id: string, record: RecoveryArtifact): Promise<void>;
}
export interface RecoveryArtifact {
  requirements: ComposeGenerationRequirements;
  artifact: ComposeRevisionArtifact;
}
/** Every report field is evaluator-owned metadata or a safe scalar, never raw output. */
export class FileReporter implements Reporter {
  constructor(
    readonly directory: string,
    private readonly output: (line: string) => void = (line) =>
      process.stdout.write(line),
  ) {}
  async initialize(): Promise<void> {
    await mkdir(this.directory, { mode: 0o700, recursive: true });
    // Exclusive creation prevents accidental reuse of another run's files.
    await writeFile(join(this.directory, "terminal.log"), "", {
      flag: "wx",
      mode: 0o600,
    });
  }
  async line(value: string): Promise<void> {
    await appendFile(join(this.directory, "terminal.log"), value + "\n", {
      mode: 0o600,
    });
    this.output(value + "\n");
  }
  async checkpoint(report: EvaluationReport): Promise<void> {
    score(report);
    await writeFile(
      join(this.directory, "results.json.tmp"),
      JSON.stringify(report, null, 2) + "\n",
      { mode: 0o600 },
    );
    await rename(
      join(this.directory, "results.json.tmp"),
      join(this.directory, "results.json"),
    );
  }
  async saveArtifact(id: string, record: RecoveryArtifact): Promise<void> {
    if (!/^C(?:0[1-9]|10)$/.test(id)) throw new Error("INVALID_CASE");
    await writeFile(
      join(this.directory, `${id}.artifact.json`),
      JSON.stringify(record),
      { mode: 0o600, flag: "wx" },
    );
  }
}
