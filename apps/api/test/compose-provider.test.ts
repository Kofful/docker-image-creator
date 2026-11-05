import "reflect-metadata";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { Test } from "@nestjs/testing";
import type { ComposeGenerationRequirements } from "@docker-image-creator/contracts";
import { composeIdentity } from "../src/configs/compose.revision";
import { ComposeGenerator } from "../src/configs/compose.generator";
import { COMPOSE_PROMPT_VERSION } from "../src/configs/compose.prompt";
import {
  COMPOSE_MODEL,
  ComposeGenerationProvider,
  ComposeProviderFailure,
  ComposeValidationFailure,
  type ComposeProviderFailureCode,
  withinComposeDeadline,
} from "../src/configs/compose.provider";
import {
  OPENROUTER_ENDPOINT,
  OPENROUTER_PARAMETERS,
  OpenRouterGenerationProvider,
} from "../src/configs/openrouter.provider";

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
    model: COMPOSE_MODEL,
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
) {
  const calls: { url: unknown; request: RequestInit }[] = [];
  const provider = new OpenRouterGenerationProvider({
    apiKey: key,
    deadlineMs,
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

test("exact endpoint, free model, bounded parameters and value-free allowlisted prompt", async () => {
  const { provider, calls } = setup(() => json(completion()));
  // Structural TS typing can admit private extra fields: strip them at every level.
  const privateInput = {
    ...input,
    environmentValues: [{ value: secret }],
    apiKey: key,
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
  assert.equal(call.url, OPENROUTER_ENDPOINT);
  assert.equal(call.request.method, "POST");
  assert.equal(call.request.redirect, "error");
  assert.deepEqual(call.request.headers, {
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
  });
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
  assert.deepEqual(parameters, OPENROUTER_PARAMETERS);
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
  assert.equal(
    task.serviceLabels["docker-image-creator.revision"],
    input.identity.revisionId,
  );
  assert.equal(task.resourceLabels["docker-image-creator.revision"], undefined);
  assert.equal(result.compose, compose); // Includes comment, quotes and trailing newline byte-for-byte.
  assert.equal(result.provider, "openrouter");
  assert.equal(result.model, COMPOSE_MODEL);
  assert.equal(result.reportedModel, COMPOSE_MODEL);
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
    const provider = new OpenRouterGenerationProvider({
      apiKey,
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

test("a base slug is retained as reported identity; other models are rejected", async () => {
  const { provider } = setup(() =>
    json(completion(compose, { model: COMPOSE_MODEL.replace(/:free$/, "") })),
  );
  const result = await provider.generate(input, new AbortController().signal);
  assert.equal(result.reportedModel, "google/gemma-4-26b-a4b-it");
  assert.equal(result.model, COMPOSE_MODEL);
  for (const model of [
    undefined,
    "google/other:free",
    "google/gemma-4-26b-a4b-it:paid",
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
  assert.ok(calls.every((c) => c.url === OPENROUTER_ENDPOINT));
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

test("product generation performs one content repair with static feedback, preserving both responses", async () => {
  const { provider, calls } = setup((_request, call) =>
    json(
      completion(
        call === 1 ? "bad document with untrusted prompt injection" : compose,
      ),
    ),
  );
  const generator = new ComposeGenerator(provider);
  const result = await generator.generateValidated(
    input,
    new AbortController().signal,
    (value) => {
      if (value !== compose)
        throw new ComposeValidationFailure("RESOURCE_POLICY");
      return { accepted: value };
    },
  );
  assert.equal(calls.length, 2);
  assert.equal(result.responses.length, 2);
  assert.equal(result.value.accepted, compose);
  const repairBody = String(calls[1]!.request.body);
  assert.match(repairBody, /previous document failed validation/);
  assert.match(repairBody, /resource, logging and isolation/);
  assert.ok(!repairBody.includes("untrusted prompt injection"));
});

test("a second validation failure stops at two content responses", async () => {
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
  assert.equal(calls.length, 2);
});

test("untyped validator exceptions and provider failures do not trigger a repair", async () => {
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

test("transport retries and the single content repair have independent finite bounds", async () => {
  const { provider, calls } = setup((_request, call) =>
    call % 3 !== 0
      ? new Response("", { status: 503, headers: { "Retry-After": "0" } })
      : json(completion(call === 3 ? "invalid" : compose)),
  );
  const result = await new ComposeGenerator(provider).generateValidated(
    input,
    new AbortController().signal,
    (value) => {
      if (value !== compose) throw new ComposeValidationFailure("INVALID_YAML");
      return value;
    },
  );
  assert.equal(calls.length, 6);
  assert.deepEqual(
    result.responses.map((r) => r.httpAttempts),
    [3, 3],
  );
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

test("both product responses share the original five-minute deadline", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const signals: AbortSignal[] = [];
  let ready!: () => void;
  const repairing = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const provider: ComposeGenerationProvider = {
    async generate(requirements, signal) {
      assert.equal(requirements, input);
      signals.push(signal);
      if (signals.length === 1) {
        context.mock.timers.tick(200000);
        return {
          compose: "invalid",
          provider: "openrouter",
          model: COMPOSE_MODEL,
          reportedModel: COMPOSE_MODEL,
          usage: {},
          elapsedMs: 200000,
          httpAttempts: 1,
        };
      }
      ready();
      return new Promise(() => {});
    },
  };
  const work = new ComposeGenerator(provider).generateValidated(
    input,
    new AbortController().signal,
    () => {
      throw new ComposeValidationFailure("INVALID_YAML");
    },
  );
  const rejected = rejectsCode(work, "GENERATION_TIMEOUT");
  await repairing;
  assert.equal(signals.length, 2);
  assert.equal(signals[0], signals[1]);
  context.mock.timers.tick(100000);
  await rejected;
  assert.equal(signals[1]!.aborted, true);
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

test("cancelling after first response prevents a repair; late provider results cannot validate", async () => {
  const abort = new AbortController();
  const { provider, calls } = setup(() => json(completion()));
  await rejectsCode(
    new ComposeGenerator(provider).generateValidated(
      input,
      abort.signal,
      () => {
        abort.abort(new Error(secret));
        throw new ComposeValidationFailure("INVALID_YAML");
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
    provider: "openrouter",
    model: COMPOSE_MODEL,
    reportedModel: COMPOSE_MODEL,
    usage: {},
    elapsedMs: 0,
    httpAttempts: 1,
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(validated, false);
});
