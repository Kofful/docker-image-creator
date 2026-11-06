import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { ComposeProviderFailure } from "../src/configs/compose.provider";
import { OpenRouterGenerationProvider } from "../src/configs/openrouter.provider";
import { EvaluationDockerDriver } from "./driver";
import { evaluate } from "./evaluator";
import { FileReporter } from "./report";
import { recover } from "./recovery";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(
      "pnpm eval:compose\nRuns all ten cases sequentially using the pinned free OpenRouter model; first response, no repair.\nRequires operator-exported OPENROUTER_API_KEY and supported Docker/Compose. No env files or application database are loaded.\nReports: .runtime/evaluations/<runId>/{terminal.log,results.json}. Disposable test data is deleted after each case.\nSIGINT/SIGTERM cancel inference/execution and attempt bounded cleanup. Exit 0 means a complete, cleaned run (any model score); exit 1 means an operational failure/incomplete run.\npnpm eval:compose --cleanup <runId> retries only pending/failed cleanup using revalidated secret-free artifacts; no key, inference, or Start.\n",
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
    process.stderr.write(
      "Usage: pnpm eval:compose [--help | --cleanup <runId>]\n",
    );
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
    const apiKey = process.env.OPENROUTER_API_KEY;
    class ConfiguredDriver extends EvaluationDockerDriver {
      override async preflight(signal: AbortSignal): Promise<void> {
        if (!apiKey?.trim() || /[\r\n]/.test(apiKey))
          throw new ComposeProviderFailure("PROVIDER_NOT_CONFIGURED");
        await super.preflight(signal);
      }
    }
    await reporter.line(`Report directory: ${directory}`);
    const report = await evaluate({
      runId,
      provider: new OpenRouterGenerationProvider({ apiKey }),
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
