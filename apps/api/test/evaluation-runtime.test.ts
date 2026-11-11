import "reflect-metadata";
import assert from "node:assert/strict";
import { test } from "node:test";
import { parse, stringify } from "yaml";
import { CASES, prepareCase } from "../evaluation/cases";
import { EvaluationDockerDriver } from "../evaluation/driver";
import { validateCompose } from "../src/configs/compose.validator";
import { composeMessages } from "../src/configs/compose.prompt";
import type { RuntimeTarget } from "../src/runtime/runtime.driver";
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

class MongoHealthcheckDriver extends EvaluationDockerDriver {
  async check(
    target: RuntimeTarget,
    test: string[],
    signal: AbortSignal,
    denied = false,
  ) {
    return this.command(
      [
        "exec",
        ...(denied
          ? [
              "--env",
              "MONGO_INITDB_ROOT_PASSWORD=deliberately-incorrect-test-password",
            ]
          : []),
        await this.terminalContainer(target, "db"),
        ...test.slice(1),
      ],
      signal,
    );
  }
}

test(
  "MongoDB prompt healthcheck authenticates raw credentials and rejects an incorrect password",
  { timeout: 3 * 60000 },
  async (context) => {
    const prepared = prepareCase(CASES[3]!);
    for (const entry of prepared.requirements.environment)
      prepared.secrets[entry.reference] = "test-$'\"\\ # café";
    const driver = new MongoHealthcheckDriver();
    const fixture = runtimeFixture(
      prepared.requirements.identity,
      prepared.requirements.services,
      prepared.requirements.environment,
    );
    const request = JSON.parse(
      composeMessages(prepared.requirements)[1]!.content,
    ) as {
      mongodbHealthcheck: { healthcheckTest: string[] };
    };
    const document = parse(fixture.manifest);
    document.services.db.healthcheck.test =
      request.mongodbHealthcheck.healthcheckTest;
    const artifact = validateCompose(
      stringify(document),
      prepared.requirements,
    );
    const target = {
      ...fixture,
      manifest: artifact.compose,
      digest: artifact.digest,
      metadata: artifact.metadata,
      secrets: prepared.secrets,
    };
    const signal = context.signal;
    try {
      await driver.launch(target, signal);
      assert.ok(
        await driver.probe(
          target,
          prepared,
          { id: "environment", service: "db", kind: "environment" },
          signal,
        ),
      );
      await driver.check(
        target,
        request.mongodbHealthcheck.healthcheckTest,
        signal,
      );
      await assert.rejects(
        driver.check(
          target,
          request.mongodbHealthcheck.healthcheckTest,
          signal,
          true,
        ),
      );
      await driver.stop(target, signal);
      await driver.launch(target, signal);
      await driver.check(
        target,
        request.mongodbHealthcheck.healthcheckTest,
        signal,
      );
    } finally {
      await driver.cleanup(
        { ...target, secrets: {} },
        AbortSignal.timeout(60000),
      );
    }
  },
);

// Additional regression probes read the whole password, including trailing
// newlines. The fixed C09 benchmark probes intentionally read a single line.
class MysqlBootstrapDriver extends EvaluationDockerDriver {
  async query(
    target: RuntimeTarget,
    root: boolean,
    query: string,
    signal: AbortSignal,
    denied = false,
  ) {
    const name = root ? "MYSQL_ROOT_PASSWORD" : "MYSQL_PASSWORD";
    const reference = target.requirements.environment.find((entry) =>
      entry.bindings.some((binding) => binding.name === name),
    )!.reference;
    const script = [
      'MYSQL_PWD="$(cat; printf .)"',
      'MYSQL_PWD="${MYSQL_PWD%.}"; export MYSQL_PWD',
      'output=$(mysql --no-defaults --connect-timeout=3 --protocol=TCP -h 127.0.0.1 --user="$1" --database="$MYSQL_DATABASE" --batch --skip-column-names -e "$2" 2>&1); status=$?',
      'if [ "$status" = 0 ] && [ "$output" = 1 ]; then printf PASS; else case "$output" in *"ERROR 1045 ("*) printf DENIED;; *) printf FAIL;; esac; fi',
    ].join("\n");
    return this.command(
      [
        "exec",
        "-i",
        await this.terminalContainer(target, "db"),
        "sh",
        "-c",
        script,
        "--",
        root ? "root" : "app",
        query,
      ],
      signal,
      denied
        ? "deliberately-incorrect-test-password"
        : target.secrets[reference],
    );
  }
}

for (const extended of [false, true])
  test(
    `C09 MySQL ${extended ? "with multiline root/app credentials and SQL-like text" : "with suite credentials"} initializes exact values and retains data after Stop/Start`,
    { timeout: 5 * 60000 },
    async (context) => {
      const prepared = prepareCase(CASES[8]!);
      if (extended) {
        prepared.requirements.services[0]!.database = "orders_archive";
        for (const entry of prepared.requirements.environment)
          prepared.secrets[entry.reference] +=
            "'\"; DROP DATABASE orders_archive; -- \\c $ # café\r\nlast line\n";
      }
      const driver = new MysqlBootstrapDriver();
      const fixture = runtimeFixture(
        prepared.requirements.identity,
        prepared.requirements.services,
        prepared.requirements.environment,
      );
      // Exercise the exact example sent to the model, after YAML serialization
      // and real Compose interpolation, rather than a separate test bootstrap.
      const request = JSON.parse(
        composeMessages(prepared.requirements)[1]!.content,
      ) as {
        mysqlBootstrap: { command: string[]; healthcheckTest: string[] };
      };
      const document = parse(fixture.manifest) as {
        services: {
          db: { command: string[]; healthcheck: { test: string[] } };
        };
      };
      document.services.db.command = request.mysqlBootstrap.command;
      document.services.db.healthcheck.test =
        request.mysqlBootstrap.healthcheckTest;
      const artifact = validateCompose(
        stringify(document),
        prepared.requirements,
      );
      const target = {
        ...fixture,
        manifest: artifact.compose,
        metadata: artifact.metadata,
        digest: artifact.digest,
        secrets: prepared.secrets,
      };
      const signal = AbortSignal.any([
        context.signal,
        AbortSignal.timeout(3 * 60000),
      ]);
      try {
        await driver.launch(target, signal);
        if (!extended)
          for (const probe of prepared.definition.probes)
            assert.ok(
              await driver.probe(target, prepared, probe, signal),
              `C09 probe failed: ${probe.id}`,
            );
        assert.ok(
          await driver.probe(
            target,
            prepared,
            { id: "environment", service: "db", kind: "environment" },
            signal,
          ),
          "Exact environment delivery failed",
        );
        for (const root of [false, true]) {
          assert.equal(
            await driver.query(target, root, "SELECT 1", signal),
            "PASS",
            "Exact credential authentication failed",
          );
          assert.equal(
            await driver.query(target, root, "SELECT 1", signal, true),
            "DENIED",
            "Wrong password was not rejected",
          );
        }
        assert.equal(
          await driver.query(
            target,
            false,
            "SELECT CONVERT_TZ('2020-01-01 00:00:00','UTC','UTC') = '2020-01-01 00:00:00'",
            signal,
          ),
          "PASS",
          "Stock timezone initialization was not preserved",
        );
        if (extended)
          assert.equal(
            await driver.query(
              target,
              false,
              "CREATE TABLE evaluation_marker (id INT PRIMARY KEY); INSERT INTO evaluation_marker VALUES (1); SELECT 1",
              signal,
            ),
            "PASS",
          );
        await driver.stop(target, signal);
        await driver.launch(target, signal);
        assert.equal(
          await driver.query(
            target,
            false,
            "SELECT COUNT(*) FROM evaluation_marker WHERE id=1",
            signal,
          ),
          "PASS",
          "C09 persistence marker was not retained",
        );
      } finally {
        await driver.cleanup(
          { ...target, secrets: {} },
          AbortSignal.timeout(60000),
        );
      }
    },
  );

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
