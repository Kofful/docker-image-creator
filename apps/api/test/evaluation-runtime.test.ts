import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parse, stringify } from "yaml";
import { CASES, prepareCase } from "../evaluation/cases";
import { EvaluationDockerDriver } from "../evaluation/driver";
import { validateCompose } from "../src/configs/compose.validator";
import { runtimeFixture } from "./runtime-fixtures";

// Trusted test-only application programs in a frozen policy fixture. No inference,
// benchmark results, production renderer or evaluator substitution is involved.
const NODE_SERVER = `const h=require('http'),n=require('net');h.createServer(async(q,r)=>{if(q.url==='/message')return r.end(process.env.APP_MESSAGE);if(q.url==='/backend'){try{return r.end(await(await fetch('http://python:8000/message')).text())}catch{r.statusCode=503;return r.end()}}if(q.url==='/ready'){const s=n.connect(3306,'sql');let done=false;const end=ok=>{if(!done){done=true;s.destroy();r.statusCode=ok?200:503;r.end()}};s.setTimeout(1500);s.on('connect',()=>end(true));s.on('error',()=>end(false));s.on('timeout',()=>end(false));return}r.end('ok')}).listen(8000,'0.0.0.0')`;
const PYTHON_SERVER = `import http.server,os
class Handler(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  self.send_response(200);self.end_headers();self.wfile.write(os.environ['APP_MESSAGE'].encode() if self.path=='/message' else b'ok')
 def log_message(self,*args): pass
http.server.HTTPServer(('0.0.0.0',8000),Handler).serve_forever()`;

test(
  "real four-image evaluator probes: exact values/HTTP/DNS/auth, negative auth/readiness, persistence and verified test-volume cleanup",
  { timeout: 8 * 60000 },
  async (context) => {
    const prepared = prepareCase(CASES[9]!);
    const driver = new EvaluationDockerDriver();
    const fixture = runtimeFixture(
      prepared.requirements.identity,
      prepared.requirements.services,
      prepared.requirements.environment,
    );
    const document = parse(fixture.manifest) as {
      services: Record<
        string,
        { command: string[]; healthcheck: { test: string[] } }
      >;
    };
    document.services.node!.command = ["node", "-e", NODE_SERVER];
    document.services.python!.command = ["python", "-c", PYTHON_SERVER];
    document.services.sql!.healthcheck.test = [
      "CMD-SHELL",
      'MYSQL_PWD="$${MYSQL_PASSWORD}" mysql --no-defaults --connect-timeout=3 --protocol=TCP -h 127.0.0.1 -u app orders -e "SELECT 1"',
    ];
    const artifact = validateCompose(
      stringify(document),
      prepared.requirements,
    );
    const target = {
      ...fixture,
      manifest: artifact.compose,
      digest: artifact.digest,
      metadata: artifact.metadata,
      requirements: prepared.requirements,
      secrets: prepared.secrets,
    };
    const signal = AbortSignal.any([
      context.signal,
      AbortSignal.timeout(4 * 60000),
    ]);
    // Preflight is intentionally before any workload creation; no provider is used.
    await driver.preflight(signal);
    context.diagnostic(
      "Supported Docker/Compose and four pinned images available",
    );
    try {
      await driver.launch(target, signal);
      context.diagnostic(
        "Four-image fixture ready; checking independent assertions",
      );
      for (const service of target.services)
        assert.ok(
          await driver.probe(
            target,
            prepared,
            {
              id: `${service.name}:environment`,
              service: service.name,
              kind: "environment",
            },
            signal,
          ),
          "Private supplied environment comparison failed",
        );
      for (const probe of prepared.definition.probes)
        assert.ok(
          await driver.probe(target, prepared, probe, signal),
          `Trusted probe failed: ${probe.id}`,
        );
      assert.ok(
        await driver.probe(
          target,
          prepared,
          {
            id: "gateway",
            kind: "http",
            service: "node",
            path: "/backend",
            message: "python:APP_MESSAGE",
          },
          signal,
        ),
        "Cross-service HTTP probe failed",
      );
      assert.ok(
        await driver.probe(
          target,
          prepared,
          { id: "write", kind: "mysql", service: "sql", mode: "write" },
          signal,
        ),
        "Persistence write probe failed",
      );
      await driver.stop(target, signal);
      await driver.launch(target, signal);
      assert.ok(
        await driver.probe(
          target,
          prepared,
          { id: "retained", kind: "mysql", service: "sql", mode: "retained" },
          signal,
        ),
        "Persistence read probe failed",
      );
      assert.ok(
        await driver.probe(
          target,
          prepared,
          { id: "ready", kind: "http", service: "node", path: "/ready" },
          signal,
        ),
        "Positive readiness probe failed",
      );
      await driver.stopService(target, "sql", signal);
      assert.ok(
        await driver.probe(
          target,
          prepared,
          {
            id: "unavailable",
            kind: "http",
            service: "node",
            path: "/ready",
            unavailable: true,
          },
          signal,
        ),
        "Negative readiness probe failed",
      );
    } finally {
      try {
        await driver.cleanup(
          { ...target, secrets: {} },
          AbortSignal.timeout(3 * 60000),
        );
      } catch {
        assert.fail(
          `Disposable evaluator cleanup needs recovery for project ${prepared.requirements.identity.projectName}; no unrelated resources were touched`,
        );
      }
      for (const key of Object.keys(prepared.secrets))
        delete prepared.secrets[key];
    }
  },
);
