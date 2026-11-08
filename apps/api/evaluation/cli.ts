import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { OpenAICompatibleGenerationProvider } from "../src/configs/openai-compatible.provider";
import { FileLlmBodyLogger } from "../src/configs/llm-body-log";
import { EvaluationDockerDriver } from "./driver";
import { evaluate } from "./evaluator";
import { FileReporter } from "./report";
import { recover } from "./recovery";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(
      "docker compose --env-file .env -f infra/docker-compose.yml exec runner node dist-evaluation/evaluation/cli.js\nRuns all ten cases as a separate process inside the existing runner container using the configured OpenAI-compatible model; first response, no repair. No host Node or pnpm is required.\nRebuild/recreate runner once after upgrading. Compose supplies operator-managed OPENAI_BASE_URL, OPENAI_API_KEY and OPENAI_MODEL to runner. The CLI loads no env files or application database.\nReports: /app/.runtime/evaluations/<runId>/{terminal.log,results.json}, persisted in the repository's .runtime/evaluations bind mount. Redacted request/response JSON files are under llm/<userId>/<configId>/<revisionId>/. Disposable test data is deleted after each case.\nKeep this command attached; Ctrl+C cancels inference/execution and attempts bounded cleanup. Avoid restarting runner during evaluation; container shutdown may kill the exec process before cleanup. Exit 0 means a complete, cleaned run (any model score); exit 1 means an operational failure/incomplete run.\nAppend --cleanup <runId> to retry only pending/failed cleanup using revalidated secret-free artifacts; no key, inference, or Start is needed by recovery. Append --help for this usage.\n",
    );
    return;
  }
  const cleanup =
    args.length === 2 &&
    args[0] === "--cleanup" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
      args[1]!,
    );
  if (args.length && !cleanup) {
    process.stderr.write("Usage: evaluation [--help | --cleanup <runId>]\n");
    process.exitCode = 1;
    return;
  }
  const runId = cleanup ? args[1]! : randomUUID();
  const directory = join(
    resolve(__dirname, "../../../.."),
    ".runtime",
    "evaluations",
    runId,
  );
  const reporter = new FileReporter(directory);
  if (!cleanup) await reporter.initialize();
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  // A closed terminal pipe cancels work instead of bypassing cleanup via an
  // unhandled stdout error. Keep the listener for the process's final flush.
  process.stdout.on("error", () => {
    controller.abort();
    process.exitCode = 1;
  });
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    if (cleanup) {
      const report = await recover(
        directory,
        runId,
        new EvaluationDockerDriver(),
        reporter,
        controller.signal,
      );
      if (
        report.cases.some((row) => ["pending", "failed"].includes(row.cleanup))
      )
        process.exitCode = 1;
      return;
    }
    // Never load an env file. The operator supplies this process variable privately.
    const provider = new OpenAICompatibleGenerationProvider({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.OPENAI_BASE_URL,
      model: process.env.OPENAI_MODEL,
      bodyLog: new FileLlmBodyLogger(join(directory, "llm")),
    });
    class ConfiguredDriver extends EvaluationDockerDriver {
      override async preflight(signal: AbortSignal): Promise<void> {
        provider.assertConfigured();
        await super.preflight(signal);
      }
    }
    await reporter.line(`Report directory: ${directory}`);
    await reporter.line(
      `Redacted LLM request/response bodies: ${join(directory, "llm")}`,
    );
    const report = await evaluate({
      runId,
      provider,
      runtime: new ConfiguredDriver(),
      reporter,
      signal: controller.signal,
    });
    if (!report.operationallySuccessful) process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}
void main().catch(() => {
  // Filesystem/console errors are not safe to echo verbatim either.
  process.stderr.write(
    "Evaluation could not finish. Check the last report checkpoint for pending resource identities; verify cleanup before starting another run.\n",
  );
  process.exitCode = 1;
});
