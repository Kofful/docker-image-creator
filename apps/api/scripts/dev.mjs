import { spawn } from "node:child_process";
import { once } from "node:events";
import { clearTimeout, setTimeout } from "node:timers";
import ts from "typescript";

let server;
let stopping = false;
let revision = 0;
let pendingRestart = Promise.resolve();

async function stopServer() {
  const previous = server;
  if (!previous) return;
  server = undefined;
  if (previous.exitCode !== null || previous.signalCode !== null) return;
  const closed = once(previous, "close");
  previous.kill("SIGTERM");
  const deadline = setTimeout(() => previous.kill("SIGKILL"), 5000);
  try {
    await closed;
  } finally {
    clearTimeout(deadline);
  }
}

function restartServer() {
  const requestedRevision = ++revision;
  pendingRestart = pendingRestart.then(async () => {
    if (stopping || requestedRevision !== revision) return;
    await stopServer();
    if (stopping || requestedRevision !== revision) return;
    server = spawn(process.execPath, ["dist/main.js"], { stdio: "inherit" });
    server.on("error", (error) =>
      console.error("API process failed:", error.message),
    );
  });
}

const diagnosticHost = {
  getCanonicalFileName: (file) => file,
  getCurrentDirectory: ts.sys.getCurrentDirectory,
  getNewLine: () => ts.sys.newLine,
};
const polling = process.env.DEV_WATCH_POLLING === "true";
const host = ts.createWatchCompilerHost(
  "tsconfig.json",
  { noEmitOnError: true },
  ts.sys,
  ts.createEmitAndSemanticDiagnosticsBuilderProgram,
  (diagnostic) =>
    console.error(ts.formatDiagnostic(diagnostic, diagnosticHost)),
  (diagnostic) => console.log(ts.formatDiagnostic(diagnostic, diagnosticHost)),
  polling
    ? {
        watchFile: ts.WatchFileKind.DynamicPriorityPolling,
        watchDirectory: ts.WatchDirectoryKind.DynamicPriorityPolling,
      }
    : undefined,
);
const compile = host.afterProgramCreate;
host.afterProgramCreate = (program) => {
  compile?.(program);
  // Preserve decorator metadata and restart only after a complete valid build.
  if (ts.getPreEmitDiagnostics(program.getProgram()).length === 0)
    restartServer();
};
const watcher = ts.createWatchProgram(host);

async function shutdown() {
  if (stopping) return;
  stopping = true;
  watcher.close();
  await pendingRestart;
  await stopServer();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
