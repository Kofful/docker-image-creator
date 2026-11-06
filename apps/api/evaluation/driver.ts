import type { ComposeIdentity } from "@docker-image-creator/contracts";
import { setTimeout as delay } from "node:timers/promises";
import { CATALOG } from "../src/configs/image.catalog";
import { composeResourceLabels } from "../src/configs/compose.policy";
import {
  DockerRuntimeDriver,
  RuntimeFailure,
  type RuntimeTarget,
} from "../src/runtime/runtime.driver";
import { suppliedValue, type PreparedCase, type Probe } from "./cases";

export interface StartupTiming {
  pullMs: number;
  readinessMs: number;
}
export interface EvaluationRuntime {
  preflight(signal: AbortSignal): Promise<void>;
  launch(target: RuntimeTarget, signal: AbortSignal): Promise<StartupTiming>;
  startupTiming(): StartupTiming;
  healthy(target: RuntimeTarget, signal: AbortSignal): Promise<boolean>;
  probe(
    target: RuntimeTarget,
    prepared: PreparedCase,
    probe: Probe,
    signal: AbortSignal,
  ): Promise<boolean>;
  stopService(
    target: RuntimeTarget,
    service: string,
    signal: AbortSignal,
  ): Promise<void>;
  stop(target: RuntimeTarget, signal: AbortSignal): Promise<void>;
  cleanup(target: RuntimeTarget, signal: AbortSignal): Promise<void>;
}

// Fixed trusted programs. Private values are stdin, never command arguments or output.
const NODE_HTTP = `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',async()=>{try{const p=JSON.parse(s);const r=await fetch('http://127.0.0.1:8000'+p.path,{signal:AbortSignal.timeout(3000),redirect:'error'});let n=0,b=[];for await(const c of r.body){n+=c.length;if(n>8192)throw 0;b.push(c)}const ok=p.unavailable?(r.status>=400&&r.status<=599):(r.status===200&&(p.message===undefined||Buffer.concat(b).toString('utf8')===p.message));console.log(ok?'PASS':'FAIL')}catch{console.log('FAIL')}})`;
const PYTHON_HTTP = `import sys,json,urllib.request,urllib.error
p=json.load(sys.stdin)
try:
 r=urllib.request.urlopen('http://127.0.0.1:8000'+p['path'],timeout=3)
 b=r.read(8193)
 ok=not p.get('unavailable') and r.status==200 and len(b)<=8192 and ('message' not in p or b.decode('utf-8')==p['message'])
except urllib.error.HTTPError as e:
 ok=bool(p.get('unavailable')) and 400<=e.code<=599
except Exception: ok=False
print('PASS' if ok else 'FAIL')`;
const NODE_TCP = `const p=JSON.parse(process.argv[1]);const s=require('net').connect(p.port,p.host);s.setTimeout(3000);let done=false;const end=ok=>{if(!done){done=true;s.destroy();console.log(ok?'PASS':'FAIL')}};s.on('connect',()=>end(true));s.on('error',()=>end(false));s.on('timeout',()=>end(false));`;
const PYTHON_TCP = `import socket,json,sys
p=json.loads(sys.argv[1])
try:
 with socket.create_connection((p['host'],p['port']),timeout=3): pass
 print('PASS')
except Exception: print('FAIL')`;
const MONGO = `try{const p=JSON.parse(require('fs').readFileSync(0,'utf8'));try{const c=new Mongo('mongodb://app:'+encodeURIComponent(p.password)+'@127.0.0.1:27017/admin?serverSelectionTimeoutMS=3000&connectTimeoutMS=3000&socketTimeoutMS=3000');const ok=c.getDB('admin').runCommand({ping:1}).ok===1;print(!p.denied&&ok?'PASS':'FAIL')}catch(e){print(p.denied&&e.code===18?'PASS':'FAIL')}}catch{print('FAIL')}`;

export class EvaluationDockerDriver
  extends DockerRuntimeDriver
  implements EvaluationRuntime
{
  private timing: StartupTiming = { pullMs: 0, readinessMs: 0 };
  private startupBegan?: number;
  protected override async command(
    args: string[],
    signal: AbortSignal,
    input?: string,
    secrets?: Record<string, string>,
    ms?: number,
  ): Promise<string> {
    const started = performance.now();
    if (args[0] === "compose" && args.includes("up"))
      this.startupBegan = started;
    try {
      return await super.command(args, signal, input, secrets, ms);
    } finally {
      if (
        args[0] === "compose" &&
        args.includes("pull") &&
        !args.includes("up")
      )
        this.timing.pullMs += Math.round(performance.now() - started);
      if (args[0] === "compose" && args.includes("up"))
        this.timing.readinessMs += Math.round(performance.now() - started);
    }
  }
  async preflight(signal: AbortSignal): Promise<void> {
    const info = JSON.parse(
      await this.command(["info", "--format", "{{json .}}"], signal),
    ) as {
      ServerVersion: string;
      OSType: string;
      MemoryLimit: boolean;
      CpuCfsQuota: boolean;
      PidsLimit: boolean;
    };
    if (
      !/^\d+\./.test(info.ServerVersion) ||
      Number(info.ServerVersion.split(".")[0]) < 28 ||
      info.OSType !== "linux" ||
      !info.MemoryLimit ||
      !info.CpuCfsQuota ||
      !info.PidsLimit
    )
      throw new RuntimeFailure("UNSUPPORTED_DOCKER");
    const version = await this.command(
      ["compose", "version", "--short"],
      signal,
    );
    const composeVersion = /^v?2\.(\d+)\.(\d+)(?:$|[-+])/.exec(version);
    if (
      !composeVersion ||
      Number(composeVersion[1]) < 29 ||
      (Number(composeVersion[1]) === 29 && Number(composeVersion[2]) < 1)
    )
      throw new RuntimeFailure("UNSUPPORTED_COMPOSE");
    // Resolve/pull every pin before any inference, without a Compose/env file.
    for (const { image } of Object.values(CATALOG)) {
      await this.command(
        ["pull", "--quiet", image],
        signal,
        undefined,
        {},
        300000,
      ).catch(() => {
        throw new RuntimeFailure("IMAGE_PULL_FAILED");
      });
      await this.command(
        ["image", "inspect", image, "--format", "{{.Id}}"],
        signal,
      );
    }
  }
  async launch(
    target: RuntimeTarget,
    signal: AbortSignal,
  ): Promise<StartupTiming> {
    this.timing = { pullMs: 0, readinessMs: 0 };
    this.startupBegan = undefined;
    try {
      await this.start(target, signal);
    } finally {
      if (this.startupBegan !== undefined)
        this.timing.readinessMs = Math.round(
          performance.now() - this.startupBegan,
        );
    }
    return { ...this.timing };
  }
  startupTiming(): StartupTiming {
    return { ...this.timing };
  }
  async healthy(target: RuntimeTarget, signal: AbortSignal): Promise<boolean> {
    return (await this.observe(target, signal)).ready;
  }
  async stopService(
    target: RuntimeTarget,
    service: string,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const id = await this.terminalContainer(target, service);
    await this.command(
      ["stop", "--time", "5", id],
      signal,
      undefined,
      {},
      15000,
    );
  }
  async probe(
    target: RuntimeTarget,
    prepared: PreparedCase,
    probe: Probe,
    signal: AbortSignal,
  ): Promise<boolean> {
    signal.throwIfAborted();
    const id = await this.terminalContainer(target, probe.service);
    const service = target.services.find(
      (entry) => entry.name === probe.service,
    )!;
    if (probe.kind === "environment") {
      const actual = JSON.parse(
        await this.command(
          ["inspect", "--format", "{{json .Config.Env}}", id],
          signal,
        ),
      ) as string[];
      const assigned = target.requirements.environment.every((entry) =>
        entry.bindings
          .filter((binding) => binding.service === probe.service)
          .every((binding) =>
            actual.includes(
              `${binding.name}=${target.secrets[entry.reference]}`,
            ),
          ),
      );
      const publicSettings =
        service.image === "mysql"
          ? { MYSQL_DATABASE: service.database ?? "app", MYSQL_USER: "app" }
          : service.image === "mongodb"
            ? {
                MONGO_INITDB_DATABASE: service.database ?? "app",
                MONGO_INITDB_ROOT_USERNAME: "app",
              }
            : {};
      return (
        assigned &&
        Object.entries(publicSettings).every(([key, value]) =>
          actual.includes(`${key}=${value}`),
        )
      );
    }
    let args: string[];
    let input: string | undefined;
    if (probe.kind === "http") {
      const parts = probe.message?.split(":");
      const message = parts
        ? suppliedValue(
            prepared,
            parts.length === 2 ? parts[0]! : probe.service,
            parts.at(-1)!,
          )
        : undefined;
      input = JSON.stringify({
        path: probe.path,
        unavailable: probe.unavailable,
        message,
      });
      args =
        service.image === "node"
          ? ["node", "-e", NODE_HTTP]
          : ["python", "-c", PYTHON_HTTP];
    } else if (probe.kind === "tcp") {
      const endpoint = JSON.stringify({ host: probe.host, port: probe.port });
      args =
        service.image === "node"
          ? ["node", "-e", NODE_TCP, endpoint]
          : ["python", "-c", PYTHON_TCP, endpoint];
    } else if (probe.kind === "mongodb") {
      input = JSON.stringify({
        password: probe.denied
          ? "deliberately-incorrect-evaluation-password"
          : suppliedValue(
              prepared,
              probe.service,
              "MONGO_INITDB_ROOT_PASSWORD",
            ),
        denied: probe.denied,
      });
      args = ["mongosh", "--nodb", "--quiet", "--eval", MONGO];
    } else {
      // Suite passwords contain no newline. read -r preserves quotes/backslashes/$/#.
      input =
        (probe.mode === "denied"
          ? "deliberately-incorrect-evaluation-password"
          : suppliedValue(
              prepared,
              probe.service,
              probe.mode === "root" ? "MYSQL_ROOT_PASSWORD" : "MYSQL_PASSWORD",
            )) + "\n";
      const query =
        probe.mode === "write"
          ? "CREATE TABLE evaluation_marker (id INT PRIMARY KEY); INSERT INTO evaluation_marker VALUES (1); SELECT 1"
          : probe.mode === "retained"
            ? "SELECT COUNT(*) FROM evaluation_marker WHERE id=1"
            : "SELECT 1";
      // Database/user names are fixed evaluator constants, never model/user text.
      const command = `mysql --no-defaults --connect-timeout=3 --protocol=TCP -h 127.0.0.1 -u ${probe.mode === "root" ? "root" : "app"} orders --batch --skip-column-names -e '${query}'`;
      const check =
        probe.mode === "denied"
          ? `case "$output" in *"ERROR 1045 ("*) printf PASS;; *) printf FAIL;; esac`
          : `if [ "$status" = 0 ] && [ "$output" = 1 ]; then printf PASS; else printf FAIL; fi`;
      args = [
        "/bin/sh",
        "-c",
        `IFS= read -r MYSQL_PWD; export MYSQL_PWD; output=$(${command} 2>&1); status=$?; ${check}`,
      ];
    }
    return (
      (await this.command(
        ["exec", "-i", id, ...args],
        signal,
        input,
        {},
        12000,
      )) === "PASS"
    );
  }
  async cleanup(target: RuntimeTarget, signal: AbortSignal): Promise<void> {
    await this.stop(target, signal);
    await this.remove(target, signal);
    const project = target.requirements.identity.projectName;
    const names = [
      ...new Set(
        target.metadata.services.flatMap((service) =>
          service.volumes.map((volume) => `${project}_${volume.source}`),
        ),
      ),
    ];
    const listed = (
      await this.command(
        [
          "volume",
          "ls",
          "--quiet",
          "--filter",
          `label=docker-image-creator.config=${target.configId}`,
        ],
        signal,
      )
    )
      .split(/\s+/)
      .filter(Boolean);
    if (listed.some((name) => !names.includes(name)))
      throw new RuntimeFailure("RESOURCE_CONFLICT");
    // Explicit evaluation invocation authorizes only these disposable test volumes.
    for (const name of names) {
      const exists = await this.command(
        ["volume", "ls", "--quiet", "--filter", `name=^${name}$`],
        signal,
      );
      if (!exists) continue;
      const labels = JSON.parse(
        await this.command(
          ["volume", "inspect", "--format", "{{json .Labels}}", name],
          signal,
        ),
      ) as Record<string, string>;
      verifyLabels(labels, target.requirements.identity);
      if (labels["com.docker.compose.project"] !== project)
        throw new RuntimeFailure("RESOURCE_CONFLICT");
      await this.command(["volume", "rm", name], signal);
      if (
        await this.command(
          ["volume", "ls", "--quiet", "--filter", `name=^${name}$`],
          signal,
        )
      )
        throw new RuntimeFailure("DELETE_FAILED");
    }
    if (
      (await this.observe(target, signal)).services.some(
        (service) => service.state !== "not_created",
      )
    )
      throw new RuntimeFailure("DELETE_FAILED");
  }
}

function verifyLabels(
  labels: Record<string, string>,
  identity: ComposeIdentity,
): void {
  for (const [key, value] of Object.entries(composeResourceLabels(identity)))
    if (labels?.[key] !== value) throw new RuntimeFailure("RESOURCE_CONFLICT");
}

export const pause = (ms: number, signal: AbortSignal) =>
  delay(ms, undefined, { signal });
