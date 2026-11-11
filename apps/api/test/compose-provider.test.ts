import "reflect-metadata";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  FileLlmBodyLogger,
  bodyLogDirectory,
  redactBody,
  type LlmBodyLogger,
  type LlmBodyRecord,
} from "../src/configs/llm-body-log";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { Test } from "@nestjs/testing";
import type { ComposeGenerationRequirements } from "@docker-image-creator/contracts";
import { composeIdentity } from "../src/configs/compose.revision";
import { ComposeGenerator } from "../src/configs/compose.generator";
import { COMPOSE_PROMPT_VERSION } from "../src/configs/compose.prompt";
import {
  ComposeGenerationProvider,
  ComposeProviderFailure,
  ComposeValidationFailure,
  type ComposeProviderFailureCode,
  withinComposeDeadline,
} from "../src/configs/compose.provider";
import {
  COMPLETION_PARAMETERS,
  OpenAICompatibleGenerationProvider,
} from "../src/configs/openai-compatible.provider";

const TEST_MODEL = "modal-served-model";

const baseURL = "https://example.modal.run/v1";
const key = "disposable-mocked-provider-key";
const secret = 'private-value-$-quotes-"-never-send';
const compose = readFileSync(
  resolve(__dirname, "../../test/fixtures/direct-compose.yaml"),
  "utf8",
);
const input: ComposeGenerationRequirements = {
  inputVersion: 2,
  identity: composeIdentity(
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
  ),
  services: [
    { name: "web", type: "web-server", image: "node", language: "javascript" },
  ],
  instructions: "Serve APP_MESSAGE on port 8000 using Node's standard library.",
  environment: [
    {
      reference: "DIC_SECRET_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      purpose: "HTTP response message",
      bindings: [{ service: "web", name: "APP_MESSAGE" }],
    },
  ],
};

function completion(
  content: unknown = compose,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    model: TEST_MODEL,
    choices: [
      { finish_reason: "stop", message: { role: "assistant", content } },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 200, total_tokens: 300 },
    ...extras,
  };
}

function json(value: unknown) {
  return new Response(JSON.stringify(value));
}
function setup(
  respond: (request: RequestInit, call: number) => Response | Promise<Response>,
  deadlineMs?: number,
  bodyLog?: LlmBodyLogger,
) {
  const calls: { url: unknown; request: RequestInit }[] = [];
  const provider = new OpenAICompatibleGenerationProvider({
    apiKey: key,
    baseURL,
    model: TEST_MODEL,
    deadlineMs,
    bodyLog,
    fetch: async (url, request) => {
      assert.ok(request);
      calls.push({ url, request });
      return respond(request, calls.length);
    },
  });
  return { provider, calls };
}

async function rejectsCode(
  work: Promise<unknown>,
  code: ComposeProviderFailureCode,
) {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof ComposeProviderFailure);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.equal(error.cause, undefined);
    assert.ok(!JSON.stringify(error).includes(secret));
    assert.ok(!JSON.stringify(error).includes(key));
    return true;
  });
}

test("configured endpoint/model, bounded standard parameters and value-free allowlisted prompt", async () => {
  const { provider, calls } = setup(() => json(completion()));
  // Structural TS typing can admit private extra fields: strip them at every level.
  const privateInput = {
    ...input,
    environmentValues: [{ value: secret }],
    apiKey: key,
    baseURL,
    model: TEST_MODEL,
    identity: { ...input.identity, value: secret },
    services: input.services.map((s) => ({ ...s, password: secret })),
    environment: input.environment.map((e) => ({
      ...e,
      value: secret,
      valueKey: "private-key",
      bindings: e.bindings.map((b) => ({ ...b, value: secret })),
    })),
  };
  const result = await provider.generate(
    privateInput,
    new AbortController().signal,
  );
  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, `${baseURL}/chat/completions`);
  assert.equal(call.request.method, "POST");
  assert.equal(call.request.redirect, "error");
  const headers = new Headers(call.request.headers);
  assert.equal(headers.get("authorization"), `Bearer ${key}`);
  assert.equal(headers.get("content-type"), "application/json");
  assert.ok(call.request.signal instanceof AbortSignal);
  const body = String(call.request.body);
  assert.ok(
    !body.includes(secret) &&
      !body.includes(key) &&
      !body.includes("private-key"),
  );
  const parsed = JSON.parse(body) as {
    messages: { role: string; content: string }[];
  };
  const { messages, ...parameters } = parsed;
  assert.deepEqual(parameters, { ...COMPLETION_PARAMETERS, model: TEST_MODEL });
  assert.equal("provider" in parameters, false);
  assert.equal(messages.length, 2);
  assert.match(
    messages[0]!.content,
    new RegExp(`Prompt version: ${COMPOSE_PROMPT_VERSION}`),
  );
  assert.match(
    messages[0]!.content,
    /complete runtime-ready Docker Compose YAML/,
  );
  assert.match(messages[0]!.content, /mysql:8\.4\.11/);
  assert.match(messages[0]!.content, /gateway_mode_ipv4/);
  const task = JSON.parse(messages[1]!.content) as {
    requirements: ComposeGenerationRequirements;
    serviceLabels: Record<string, string>;
    resourceLabels: Record<string, string>;
  };
  assert.deepEqual(task.requirements, input);
  assert.equal("mysqlBootstrap" in task, false);
  assert.equal(
    task.serviceLabels["docker-image-creator.revision"],
    input.identity.revisionId,
  );
  assert.equal(task.resourceLabels["docker-image-creator.revision"], undefined);
  assert.equal(result.compose, compose); // Includes comment, quotes and trailing newline byte-for-byte.
  assert.equal(result.provider, "openai");
  assert.equal(result.model, TEST_MODEL);
  assert.equal(result.reportedModel, TEST_MODEL);
  assert.equal(result.httpAttempts, 1);
  assert.ok(result.elapsedMs >= 0);
  assert.deepEqual(result.usage, {
    promptTokens: 100,
    completionTokens: 200,
    totalTokens: 300,
  });
});

test("model text is returned unchanged and remains unvalidated, including fenced/invalid YAML", async () => {
  const content = "```yaml\nservices: [not a valid policy document]\n```\n";
  const { provider } = setup(() => json(completion(content)));
  assert.equal(
    (await provider.generate(input, new AbortController().signal)).compose,
    content,
  );
});

test("missing/blank credentials fail safely without any HTTP request", async () => {
  for (const apiKey of [undefined, "", "  ", "bad\nheader"]) {
    const provider = new OpenAICompatibleGenerationProvider({
      apiKey,
      baseURL,
      model: TEST_MODEL,
      fetch: async () => {
        assert.fail("HTTP must not run");
      },
    });
    await rejectsCode(
      provider.generate(input, new AbortController().signal),
      "PROVIDER_NOT_CONFIGURED",
    );
  }
});

test("absent/malformed usage stays optional and provider-private fields are discarded", async () => {
  for (const usage of [
    undefined,
    null,
    {
      prompt_tokens: -1,
      completion_tokens: 1.2,
      total_tokens: "3",
      debug: secret,
    },
  ]) {
    const { provider } = setup(() =>
      json(completion(compose, { usage, debug: secret })),
    );
    const result = await provider.generate(input, new AbortController().signal);
    assert.deepEqual(result.usage, {});
    assert.ok(!JSON.stringify(result).includes(secret));
  }
});

test("a different reported model is rejected without fallback", async () => {
  for (const model of [
    undefined,
    "other-model",
    "google/gemma-4-26b-a4b-it:free",
  ]) {
    const mock = setup(() => json(completion(compose, { model })));
    await rejectsCode(
      mock.provider.generate(input, new AbortController().signal),
      "PROVIDER_MODEL_MISMATCH",
    );
    assert.equal(mock.calls.length, 1);
  }
});

test("permanent HTTP failures are classified without retries or error-body exposure", async () => {
  for (const [status, code] of [
    [400, "PROVIDER_REQUEST_FAILED"],
    [401, "PROVIDER_AUTH_FAILED"],
    [403, "PROVIDER_AUTH_FAILED"],
    [402, "PROVIDER_CREDITS_REQUIRED"],
    [404, "MODEL_UNAVAILABLE"],
  ] as const) {
    const { provider, calls } = setup(
      () => new Response(`${key} ${secret}`, { status }),
    );
    await rejectsCode(
      provider.generate(input, new AbortController().signal),
      code,
    );
    assert.equal(calls.length, 1);
  }
});

test("rate limiting retries the identical request at most twice and never falls back", async () => {
  const { provider, calls } = setup(
    () =>
      new Response(secret, { status: 429, headers: { "Retry-After": "0" } }),
  );
  await rejectsCode(
    provider.generate(input, new AbortController().signal),
    "PROVIDER_RATE_LIMITED",
  );
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls.map((c) => c.request.body)).size, 1);
  assert.ok(calls.every((c) => c.url === `${baseURL}/chat/completions`));
});

test("transient server failures can recover within the same model request", async () => {
  const { provider, calls } = setup((_request, call) =>
    call < 3
      ? new Response(secret, { status: 503, headers: { "Retry-After": "0" } })
      : json(completion()),
  );
  const result = await provider.generate(input, new AbortController().signal);
  assert.equal(calls.length, 3);
  assert.equal(result.httpAttempts, 3);
});

test("HTTP 200 provider errors are classified, including transient error envelopes", async () => {
  for (const [code, expected, attempts] of [
    [401, "PROVIDER_AUTH_FAILED", 1],
    [429, "PROVIDER_RATE_LIMITED", 3],
    [503, "PROVIDER_UNAVAILABLE", 3],
  ] as const) {
    const { provider, calls } = setup(
      () =>
        new Response(
          JSON.stringify({
            error: { code, message: secret, metadata: { key } },
          }),
          { headers: { "Retry-After": "0" } },
        ),
    );
    await rejectsCode(
      provider.generate(input, new AbortController().signal),
      expected,
    );
    assert.equal(calls.length, attempts);
  }
});

test("long Retry-After seconds or dates fail without retrying prematurely", async () => {
  for (const wait of ["60", new Date(Date.now() + 60000).toUTCString()]) {
    const { provider, calls } = setup(
      () =>
        new Response(secret, { status: 429, headers: { "Retry-After": wait } }),
    );
    await rejectsCode(
      provider.generate(input, new AbortController().signal),
      "PROVIDER_RATE_LIMITED",
    );
    assert.equal(calls.length, 1);
  }
});

test("network failures retry with bounded backoff and sanitized final errors", async () => {
  const { provider, calls } = setup(() => {
    throw new Error(`${key} ${secret}`);
  });
  await rejectsCode(
    provider.generate(input, new AbortController().signal),
    "PROVIDER_UNAVAILABLE",
  );
  assert.equal(calls.length, 3);
});

test("malformed JSON/schema, error envelopes and tool calls are not accepted or retried", async () => {
  const values = [
    null,
    [],
    {},
    { error: { code: "503", message: secret } },
    completion(compose, { choices: [] }),
    completion(compose, {
      choices: [
        {
          finish_reason: "tool_calls",
          message: { role: "assistant", content: compose },
        },
      ],
    }),
    completion(compose, {
      choices: [
        {
          finish_reason: "stop",
          message: { role: "assistant", content: compose, tool_calls: [] },
        },
      ],
    }),
    completion(compose, {
      choices: [
        { finish_reason: "stop", message: { role: "user", content: compose } },
      ],
    }),
    completion(compose, {
      choices: [
        {
          finish_reason: "stop",
          message: { role: "assistant", content: compose },
          error: { message: secret },
        },
      ],
    }),
    completion(compose, {
      choices: [
        {
          finish_reason: "content_filter",
          message: { role: "assistant", content: compose },
        },
      ],
    }),
  ];
  for (const value of values) {
    const { provider, calls } = setup(() => json(value));
    await rejectsCode(
      provider.generate(input, new AbortController().signal),
      "PROVIDER_INVALID_RESPONSE",
    );
    assert.equal(calls.length, 1);
  }
  const malformed = setup(() => new Response(`not json ${secret}`));
  await rejectsCode(
    malformed.provider.generate(input, new AbortController().signal),
    "PROVIDER_INVALID_RESPONSE",
  );
});

test("empty, truncated and oversized completions are rejected without repair/retry", async () => {
  for (const content of [null, "", " \n\t"]) {
    const { provider } = setup(() => json(completion(content)));
    await rejectsCode(
      provider.generate(input, new AbortController().signal),
      "OUTPUT_EMPTY",
    );
  }
  const truncated = setup(() =>
    json(
      completion(compose, {
        choices: [
          {
            finish_reason: "length",
            message: { role: "assistant", content: compose },
          },
        ],
      }),
    ),
  );
  await rejectsCode(
    truncated.provider.generate(input, new AbortController().signal),
    "OUTPUT_TRUNCATED",
  );
  const large = setup(() => json(completion("x".repeat(1024 * 1024 + 1))));
  await rejectsCode(
    large.provider.generate(input, new AbortController().signal),
    "OUTPUT_TOO_LARGE",
  );
  const utf8 = setup(() => json(completion("😀".repeat(262145))));
  await rejectsCode(
    utf8.provider.generate(input, new AbortController().signal),
    "OUTPUT_TOO_LARGE",
  );
  assert.equal(large.calls.length, 1);
});

test("HTTP body size is bounded with and without Content-Length and cancels the stream", async () => {
  for (const contentLength of [true, false]) {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024));
      },
      cancel() {
        cancelled = true;
      },
    });
    const { provider } = setup(
      () =>
        new Response(stream, {
          headers: contentLength
            ? { "Content-Length": String(8 * 1024 * 1024 + 1) }
            : {},
        }),
    );
    await rejectsCode(
      provider.generate(input, new AbortController().signal),
      "OUTPUT_TOO_LARGE",
    );
    assert.equal(cancelled, true);
  }
});

test("invalid UTF-8 and broken body streams fail safely", async () => {
  const responses = [
    new Response(new Uint8Array([0xff])),
    new Response(
      new ReadableStream({
        start(controller) {
          controller.error(new Error(secret));
        },
      }),
    ),
  ];
  for (const response of responses) {
    const { provider } = setup(() => response);
    await rejectsCode(
      provider.generate(input, new AbortController().signal),
      "PROVIDER_INVALID_RESPONSE",
    );
  }
});

test("pre-cancelled requests do not call HTTP or expose the caller's abort reason", async () => {
  const abort = new AbortController();
  abort.abort(new Error(secret));
  const { provider, calls } = setup(() => json(completion()));
  await rejectsCode(provider.generate(input, abort.signal), "INTERRUPTED");
  assert.equal(calls.length, 0);
});

test("deadline aborts a stalled fetch even if the transport ignores its signal", async () => {
  const { provider, calls } = setup(() => new Promise<Response>(() => {}), 20);
  await rejectsCode(
    provider.generate(input, new AbortController().signal),
    "GENERATION_TIMEOUT",
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.request.signal!.aborted, true);
});

test("cancellation aborts an active response read and cancels its body", async () => {
  const abort = new AbortController();
  let cancelled = false;
  const { provider } = setup(
    () =>
      new Response(
        new ReadableStream({
          start() {
            setTimeout(() => abort.abort(new Error(secret)), 10);
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  await rejectsCode(provider.generate(input, abort.signal), "INTERRUPTED");
  assert.equal(cancelled, true);
});

test("deadline bounds Retry-After waits; no second HTTP call occurs", async () => {
  const { provider, calls } = setup(
    () =>
      new Response(secret, { status: 429, headers: { "Retry-After": "1" } }),
    20,
  );
  await rejectsCode(
    provider.generate(input, new AbortController().signal),
    "GENERATION_TIMEOUT",
  );
  assert.equal(calls.length, 1);
});

test("late HTTP responses are released after cancellation", async () => {
  let finish!: (response: Response) => void;
  const abort = new AbortController();
  let cancelled = false;
  const { provider } = setup(
    () =>
      new Promise<Response>((resolve) => {
        finish = resolve;
      }),
  );
  const work = provider.generate(input, abort.signal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  abort.abort();
  await rejectsCode(work, "INTERRUPTED");
  finish(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
});

test("product captures an invalid first response and fails without requesting a replacement", async () => {
  const invalid = "bad document with untrusted prompt injection";
  const { provider, calls } = setup((_request, call) =>
    json(completion(call === 1 ? invalid : compose)),
  );
  const captured: string[] = [];
  await assert.rejects(
    new ComposeGenerator(provider).generateValidated(
      input,
      new AbortController().signal,
      () => {
        throw new ComposeValidationFailure("RESOURCE_POLICY");
      },
      async (response) => {
        captured.push(response.compose);
      },
    ),
    { message: "RESOURCE_POLICY" },
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(captured, [invalid]);
});

test("validation failure ends generation after one content response", async () => {
  const { provider, calls } = setup(() => json(completion("invalid")));
  await assert.rejects(
    new ComposeGenerator(provider).generateValidated(
      input,
      new AbortController().signal,
      () => {
        throw new ComposeValidationFailure("INVALID_YAML");
      },
    ),
    { message: "INVALID_YAML" },
  );
  assert.equal(calls.length, 1);
});

test("untyped validator exceptions and provider failures end generation without another response", async () => {
  const { provider, calls } = setup(() => json(completion()));
  await assert.rejects(
    new ComposeGenerator(provider).generateValidated(
      input,
      new AbortController().signal,
      () => {
        throw new Error("internal validator failure");
      },
    ),
    { message: "internal validator failure" },
  );
  assert.equal(calls.length, 1);
  const failed = setup(() => new Response("", { status: 404 }));
  await rejectsCode(
    new ComposeGenerator(failed.provider).generateValidated(
      input,
      new AbortController().signal,
      () => assert.fail("must not validate"),
    ),
    "MODEL_UNAVAILABLE",
  );
  assert.equal(failed.calls.length, 1);
});

test("evaluation can score the first complete response without content repair", async () => {
  const { provider, calls } = setup(() => json(completion("invalid")));
  const result = await provider.generate(input, new AbortController().signal);
  assert.equal(result.compose, "invalid");
  assert.equal(calls.length, 1);
});

test("transport retries stay bounded and an invalid response never starts another content request", async () => {
  const { provider, calls } = setup((_request, call) =>
    call < 3
      ? new Response("", { status: 503, headers: { "Retry-After": "0" } })
      : json(completion(call === 3 ? "invalid" : compose)),
  );
  await assert.rejects(
    new ComposeGenerator(provider).generateValidated(
      input,
      new AbortController().signal,
      () => {
        throw new ComposeValidationFailure("INVALID_YAML");
      },
    ),
    { message: "INVALID_YAML" },
  );
  assert.equal(calls.length, 3);
  assert.equal(new Set(calls.map((call) => call.request.body)).size, 1);
});

test("an enclosing deadline aborts nested provider calls with the timeout classification", async () => {
  const { provider, calls } = setup(() => new Promise<Response>(() => {}));
  await rejectsCode(
    withinComposeDeadline(new AbortController().signal, 20, (bounded) =>
      provider.generate(input, bounded),
    ),
    "GENERATION_TIMEOUT",
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.request.signal!.aborted, true);
});

test("the single product response and capture share the five-minute deadline", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  let signal!: AbortSignal;
  let validated = false;
  const provider: ComposeGenerationProvider = {
    async generate(requirements, bounded) {
      assert.equal(requirements, input);
      calls++;
      signal = bounded;
      context.mock.timers.tick(200000);
      return {
        compose,
        provider: "openai",
        model: TEST_MODEL,
        reportedModel: TEST_MODEL,
        usage: {},
        elapsedMs: 200000,
        httpAttempts: 1,
      };
    },
  };
  await rejectsCode(
    new ComposeGenerator(provider).generateValidated(
      input,
      new AbortController().signal,
      () => {
        validated = true;
      },
      async () => {
        context.mock.timers.tick(100000);
      },
    ),
    "GENERATION_TIMEOUT",
  );
  assert.equal(calls, 1);
  assert.equal(signal.aborted, true);
  assert.equal(validated, false);
});

test("Nest resolves the typed provider seam and product orchestration", async () => {
  const { provider } = setup(() => json(completion()));
  const module = await Test.createTestingModule({
    providers: [
      ComposeGenerator,
      { provide: ComposeGenerationProvider, useValue: provider },
    ],
  }).compile();
  try {
    const result = await module
      .get(ComposeGenerator)
      .generateValidated(input, new AbortController().signal, (value) => value);
    assert.equal(result.value, compose);
  } finally {
    await module.close();
  }
});

test("cancelling after the first response or during capture prevents validation; late results cannot publish", async () => {
  const abort = new AbortController();
  const { provider, calls } = setup(() => json(completion()));
  await rejectsCode(
    new ComposeGenerator(provider).generateValidated(
      input,
      abort.signal,
      () => assert.fail("cancelled capture must not validate"),
      async () => {
        abort.abort(new Error(secret));
      },
    ),
    "INTERRUPTED",
  );
  assert.equal(calls.length, 1);
  let finish!: (
    result: Awaited<ReturnType<ComposeGenerationProvider["generate"]>>,
  ) => void;
  let validated = false;
  const lateProvider: ComposeGenerationProvider = {
    generate: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  };
  const secondAbort = new AbortController();
  const work = new ComposeGenerator(lateProvider).generateValidated(
    input,
    secondAbort.signal,
    () => {
      validated = true;
    },
  );
  secondAbort.abort();
  await rejectsCode(work, "INTERRUPTED");
  finish({
    compose,
    provider: "openai",
    model: TEST_MODEL,
    reportedModel: TEST_MODEL,
    usage: {},
    elapsedMs: 0,
    httpAttempts: 1,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(validated, false);
});

test("missing or unsafe endpoint/model configuration never uses an SDK default endpoint", async () => {
  const valid = { apiKey: key, baseURL, model: TEST_MODEL };
  for (const options of [
    { ...valid, baseURL: undefined },
    { ...valid, baseURL: "" },
    { ...valid, baseURL: "invalid" },
    { ...valid, baseURL: "http://example.modal.run/v1" },
    { ...valid, baseURL: "https://user:password@example.modal.run/v1" },
    { ...valid, baseURL: "https://example.modal.run/v1?key=private" },
    { ...valid, baseURL: "https://example.modal.run/v1#fragment" },
    { ...valid, baseURL: " https://example.modal.run/v1" },
    { ...valid, model: undefined },
    { ...valid, model: " " },
    { ...valid, model: "bad\nmodel" },
    { ...valid, model: "x".repeat(129) },
  ]) {
    const provider = new OpenAICompatibleGenerationProvider({
      ...options,
      fetch: async () => {
        assert.fail("HTTP must not run");
      },
    });
    assert.throws(() => provider.assertConfigured(), {
      message: "PROVIDER_NOT_CONFIGURED",
    });
    await rejectsCode(
      provider.generate(input, new AbortController().signal),
      "PROVIDER_NOT_CONFIGURED",
    );
  }
});

test("SDK error parsing cannot read an unbounded private error body", async () => {
  let cancelled = false;
  const { provider, calls } = setup(
    () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new TextEncoder().encode(secret));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 401 },
      ),
  );
  await rejectsCode(
    provider.generate(input, new AbortController().signal),
    "PROVIDER_AUTH_FAILED",
  );
  assert.equal(cancelled, true);
  assert.equal(calls.length, 1);
});

test("OpenAI-compatible null tool metadata is accepted without changing content", async () => {
  const { provider } = setup(() =>
    json(
      completion(compose, {
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: compose, tool_calls: null },
          },
        ],
      }),
    ),
  );
  const result = await provider.generate(input, new AbortController().signal);
  assert.equal(result.compose, compose);
});

test("body redaction masks nested credentials, encoded keys, YAML blocks and command assignments", () => {
  const hidden = [
    key,
    "json-password",
    "yaml-password",
    "block-password",
    "command-password",
    "second-password",
    "url-user",
    "url-password",
    "bearer-value",
    "inner-password",
    "pem-value",
  ];
  const body = JSON.stringify({
    password: hidden[1],
    API_KEY: key,
    access_token: "bearer-value",
    nested: JSON.stringify({ password: "inner-password", keep: "visible" }),
    content: `services:\n  db:\n    environment:\n      MYSQL_PASSWORD: yaml-password\n      MYSQL_ROOT_PASSWORD: |\n        block-password\n      MYSQL_DATABASE: orders\ncommand: [env, NORMAL=visible PASSWORD=command-password]\ncommand: user=app password=second-password\nurl: mysql://url-user:url-password@db/orders\nAuthorization: Bearer bearer-value\n-----BEGIN PRIVATE KEY-----\npem-value\n-----END PRIVATE KEY-----`,
    reference: "${DIC_SECRET_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:?Required value}",
    privateInput: { identity: { password: "inner-password" } },
  });
  const result = JSON.stringify(redactBody(body, [key]));
  for (const value of hidden) assert.ok(!result.includes(value), value);
  assert.ok(result.includes("orders"));
  assert.ok(result.includes("DIC_SECRET_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"));
  assert.ok(result.includes("[REDACTED]"));
  const encoded =
    '{"pa' + "\\u0073" + 'sword":"json-password","keep":"visible"}';
  assert.ok(
    !JSON.stringify(redactBody(encoded, [key])).includes("json-password"),
  );
});

test("file body logs retain the rejected first completion and transport retries with private scoped permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "dic-llm-body-"));
  try {
    const { provider, calls } = setup(
      (_request, call) =>
        call === 1
          ? new Response(
              JSON.stringify({
                error: {
                  message: `password=provider-password ${key}`,
                  code: 429,
                },
              }),
              { status: 429, headers: { "Retry-After": "0" } },
            )
          : json(completion(call === 2 ? "invalid document" : compose)),
      undefined,
      new FileLlmBodyLogger(root),
    );
    await assert.rejects(
      new ComposeGenerator(provider).generateValidated(
        input,
        new AbortController().signal,
        (value) => {
          if (value === "invalid document")
            throw new ComposeValidationFailure("INVALID_YAML");
          return value;
        },
      ),
      { message: "INVALID_YAML" },
    );
    assert.equal(calls.length, 2);
    const directory = join(root, bodyLogDirectory(input.identity));
    const files = await readdir(directory);
    assert.equal(files.length, 4);
    const records = await Promise.all(
      files.map(async (file) => {
        const text = await readFile(join(directory, file), "utf8");
        assert.ok(!text.includes(key));
        assert.ok(!text.includes("provider-password"));
        assert.equal((await stat(join(directory, file))).mode & 0o777, 0o600);
        return JSON.parse(text) as {
          direction: string;
          version: number;
          status?: number;
          attempt: number;
          body: {
            max_completion_tokens?: number;
            choices?: { message: { content: string } }[];
            messages?: unknown[];
          };
        };
      }),
    );
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.ok(records.some((row) => row.status === 429));
    assert.ok(
      records.some(
        (row) => row.body.choices?.[0]?.message.content === "invalid document",
      ),
    );
    assert.ok(records.every((row) => row.version === 2 && !("repair" in row)));
    assert.ok(
      records.some(
        (row) =>
          row.direction === "request" &&
          row.body.messages?.length === 2 &&
          row.body.max_completion_tokens === 16384,
      ),
    );
    assert.ok(records.some((row) => row.attempt === 2));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed response text and transport failures are recorded before safe failures escape", async () => {
  const records: LlmBodyRecord[] = [];
  const logger: LlmBodyLogger = {
    async write(row) {
      records.push(row);
    },
  };
  const malformed = setup(
    () => new Response("malformed YAML/JSON"),
    undefined,
    logger,
  );
  await rejectsCode(
    malformed.provider.generate(input, new AbortController().signal),
    "PROVIDER_INVALID_RESPONSE",
  );
  assert.equal(records[1]?.body, "malformed YAML/JSON");
  assert.equal(records[1]?.complete, true);
  records.length = 0;
  const network = setup(
    () => {
      throw new Error(secret);
    },
    undefined,
    logger,
  );
  await rejectsCode(
    network.provider.generate(input, new AbortController().signal),
    "PROVIDER_UNAVAILABLE",
  );
  assert.equal(records.length, 6);
  assert.ok(
    records
      .filter((row) => row.direction === "response")
      .every(
        (row) =>
          row.body === null &&
          !row.complete &&
          row.failure === "PROVIDER_UNAVAILABLE",
      ),
  );
  assert.ok(!JSON.stringify(records).includes(secret));
});

test("oversized response body logs contain a bounded prefix and truncation metadata", async () => {
  const records: LlmBodyRecord[] = [];
  let cancelled = false;
  const { provider } = setup(
    () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024).fill(120));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
    undefined,
    {
      async write(row) {
        records.push(row);
      },
    },
  );
  await rejectsCode(
    provider.generate(input, new AbortController().signal),
    "OUTPUT_TOO_LARGE",
  );
  const response = records.find((row) => row.direction === "response")!;
  assert.equal(response.bytes, 8 * 1024 * 1024);
  assert.equal(response.truncated, true);
  assert.equal(response.complete, false);
  assert.equal(response.body?.length, 8 * 1024 * 1024);
  assert.equal(cancelled, true);
});

test("body log write failure is explicit and is never retried or repaired", async () => {
  const { provider, calls } = setup(() => json(completion()), undefined, {
    async write() {
      throw new Error(secret);
    },
  });
  await rejectsCode(
    provider.generate(input, new AbortController().signal),
    "PROVIDER_LOG_FAILED",
  );
  assert.equal(calls.length, 0);
});

test("body log storage refuses cross-scope traversal, symlinks and replacement of existing records", async () => {
  const root = await mkdtemp(join(tmpdir(), "dic-llm-path-"));
  const outside = await mkdtemp(join(tmpdir(), "dic-llm-outside-"));
  const row: LlmBodyRecord = {
    identity: input.identity,
    requestId: randomUUID(),
    attempt: 1,
    direction: "request",
    body: "{}",
    complete: true,
    truncated: false,
    bytes: 2,
  };
  try {
    const logger = new FileLlmBodyLogger(root);
    await logger.write(row, [key]);
    await rejectsCode(logger.write(row, [key]), "PROVIDER_LOG_FAILED");
    await rejectsCode(
      logger.write(
        { ...row, identity: { ...row.identity, configId: "../outside" } },
        [key],
      ),
      "PROVIDER_LOG_FAILED",
    );
    await symlink(outside, join(root, "alias"));
    await rejectsCode(
      new FileLlmBodyLogger(join(root, "alias")).write(row, [key]),
      "PROVIDER_LOG_FAILED",
    );
    await rejectsCode(
      new FileLlmBodyLogger(join(root, "alias", "new-directory")).write(row, [
        key,
      ]),
      "PROVIDER_LOG_FAILED",
    );
    assert.deepEqual(await readdir(outside), []);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("large non-JSON text is redacted in bounded work and keeps its non-secret body", () => {
  const text = "x".repeat(8 * 1024 * 1024);
  assert.equal(redactBody(text, [key]), text);
});

test("response log failure stops without replaying a completed HTTP request", async () => {
  const { provider, calls } = setup(() => json(completion()), undefined, {
    async write(row) {
      if (row.direction === "response") throw new Error(secret);
    },
  });
  await rejectsCode(
    provider.generate(input, new AbortController().signal),
    "PROVIDER_LOG_FAILED",
  );
  assert.equal(calls.length, 1);
});

test("cancellation during request logging cannot start a late HTTP request", async () => {
  let release!: () => void;
  let started!: () => void;
  const logging = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { provider, calls } = setup(() => json(completion()), undefined, {
    async write(row) {
      if (row.direction === "request") {
        started();
        await pending;
      }
    },
  });
  const controller = new AbortController();
  const work = provider.generate(input, controller.signal);
  await logging;
  controller.abort();
  await rejectsCode(work, "INTERRUPTED");
  release();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 0);
});
