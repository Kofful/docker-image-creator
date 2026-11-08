import OpenAI from "openai";
import { randomUUID } from "node:crypto";
import type { LlmBodyLogger, LlmBodyRecord } from "./llm-body-log";
import { setTimeout as delay } from "node:timers/promises";
import type { ComposeGenerationRequirements } from "@docker-image-creator/contracts";
import { COMPOSE_POLICY } from "./compose.policy";
import { composeMessages } from "./compose.prompt";
import {
  abortable,
  COMPOSE_GENERATION_MS,
  ComposeGenerationProvider,
  ComposeProviderFailure,
  type ComposeProviderFailureCode,
  type ComposeProviderResult,
  withinComposeDeadline,
} from "./compose.provider";

export const COMPLETION_PARAMETERS = {
  stream: false,
  max_completion_tokens: 16384,
} as const;

const MAX_HTTP_ATTEMPTS = 3;
// JSON escaping/metadata can exceed the content's UTF-8 length.
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_RETRY_WAIT_MS = 30000;

export interface OpenAIOptions {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  bodyLog?: LlmBodyLogger;
  /** Injection seams for HTTP tests; production uses native fetch and fixed limits. */
  fetch?: typeof fetch;
  deadlineMs?: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failureForStatus(status: number): ComposeProviderFailureCode {
  if (status === 401 || status === 403) return "PROVIDER_AUTH_FAILED";
  if (status === 402) return "PROVIDER_CREDITS_REQUIRED";
  if (status === 404) return "MODEL_UNAVAILABLE";
  if (status === 429) return "PROVIDER_RATE_LIMITED";
  if (status === 408 || status >= 500) return "PROVIDER_UNAVAILABLE";
  return "PROVIDER_REQUEST_FAILED";
}

function transient(status: number) {
  return status === 408 || status === 429 || status >= 500;
}

function retryWait(headers: Headers | undefined, attempt: number): number {
  const header = headers?.get("retry-after");
  if (header !== null && header !== undefined) {
    const seconds = /^\d+(?:\.\d+)?$/.test(header) ? Number(header) : NaN;
    const wait = Number.isFinite(seconds)
      ? seconds * 1000
      : Date.parse(header) - Date.now();
    if (Number.isFinite(wait)) return Math.max(0, wait);
  }
  return 500 * 2 ** attempt;
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    /* Do not expose HTTP details. */
  }
}

async function boundedBody(
  response: Response,
  signal: AbortSignal,
  capture?: (
    body: string,
    metadata: Pick<
      LlmBodyRecord,
      "bytes" | "complete" | "truncated" | "failure"
    >,
  ) => Promise<void>,
): Promise<Buffer> {
  if (
    !capture &&
    Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES
  ) {
    void discard(response);
    throw new ComposeProviderFailure("OUTPUT_TOO_LARGE");
  }
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let complete = false;
  let truncated = false;
  let failure: string | undefined;
  const reader = response.body?.getReader();
  try {
    if (!reader) {
      complete = true;
      return Buffer.alloc(0);
    }
    while (true) {
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) break;
      const remaining = MAX_RESPONSE_BYTES - bytes;
      chunks.push(chunk.value.subarray(0, remaining));
      bytes += Math.min(chunk.value.byteLength, remaining);
      if (chunk.value.byteLength > remaining) {
        truncated = true;
        throw new ComposeProviderFailure("OUTPUT_TOO_LARGE");
      }
    }
    complete = true;
    return Buffer.concat(chunks);
  } catch (error) {
    failure =
      error instanceof ComposeProviderFailure
        ? error.code
        : "PROVIDER_INVALID_RESPONSE";
    if (error instanceof ComposeProviderFailure) throw error;
    throw new ComposeProviderFailure("PROVIDER_INVALID_RESPONSE");
  } finally {
    if (!complete) void reader?.cancel().catch(() => {});
    reader?.releaseLock();
    await capture?.(Buffer.concat(chunks).toString("utf8"), {
      bytes,
      complete,
      truncated,
      ...(failure ? { failure } : {}),
    });
  }
}

async function boundedJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  const bytes = await boundedBody(response, signal);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new ComposeProviderFailure("PROVIDER_INVALID_RESPONSE");
  }
}

function readCompletion(
  value: unknown,
  model: string,
): Omit<ComposeProviderResult, "elapsedMs" | "httpAttempts"> {
  if (
    !record(value) ||
    !Array.isArray(value.choices) ||
    value.choices.length !== 1
  )
    throw new ComposeProviderFailure("PROVIDER_INVALID_RESPONSE");
  if (value.model !== model)
    throw new ComposeProviderFailure("PROVIDER_MODEL_MISMATCH");
  const choice: unknown = value.choices[0];
  if (!record(choice) || choice.error !== undefined)
    throw new ComposeProviderFailure("PROVIDER_INVALID_RESPONSE");
  if (choice.finish_reason === "length")
    throw new ComposeProviderFailure("OUTPUT_TRUNCATED");
  if (
    choice.finish_reason !== "stop" ||
    !record(choice.message) ||
    choice.message.role !== "assistant" ||
    choice.message.tool_calls != null
  )
    throw new ComposeProviderFailure("PROVIDER_INVALID_RESPONSE");
  const content = choice.message.content;
  if (
    content === null ||
    content === "" ||
    (typeof content === "string" && !content.trim())
  )
    throw new ComposeProviderFailure("OUTPUT_EMPTY");
  if (typeof content !== "string")
    throw new ComposeProviderFailure("PROVIDER_INVALID_RESPONSE");
  if (Buffer.byteLength(content, "utf8") > COMPOSE_POLICY.maxOutputBytes)
    throw new ComposeProviderFailure("OUTPUT_TOO_LARGE");
  const usage: ComposeProviderResult["usage"] = {};
  if (record(value.usage)) {
    for (const [source, target] of [
      ["prompt_tokens", "promptTokens"],
      ["completion_tokens", "completionTokens"],
      ["total_tokens", "totalTokens"],
    ] as const) {
      const tokens = value.usage[source];
      if (
        typeof tokens === "number" &&
        Number.isSafeInteger(tokens) &&
        tokens >= 0
      )
        usage[target] = tokens;
    }
  }
  return {
    compose: content,
    provider: "openai",
    model,
    reportedModel: value.model,
    usage,
  };
}

/** Direct complete-document generation only; no parsing, rendering or execution. */
export class OpenAICompatibleGenerationProvider extends ComposeGenerationProvider {
  readonly model: string;
  private readonly request: typeof fetch;
  private readonly deadlineMs: number;

  constructor(private readonly options: OpenAIOptions) {
    super();
    this.model = options.model?.trim() ?? "";
    this.request = options.fetch ?? fetch;
    this.deadlineMs = Math.min(
      options.deadlineMs ?? COMPOSE_GENERATION_MS,
      COMPOSE_GENERATION_MS,
    );
  }

  /** Shared CLI preflight; missing configuration never contacts an endpoint. */
  assertConfigured(): void {
    const { apiKey, baseURL } = this.options;
    if (
      !apiKey?.trim() ||
      /[\r\n]/.test(apiKey) ||
      !this.model ||
      this.model.length > 128 ||
      [...this.model].some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      !baseURL ||
      baseURL.trim() !== baseURL ||
      /[\s]/.test(baseURL)
    )
      throw new ComposeProviderFailure("PROVIDER_NOT_CONFIGURED");
    try {
      const url = new URL(baseURL);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error("INVALID_URL");
    } catch {
      throw new ComposeProviderFailure("PROVIDER_NOT_CONFIGURED");
    }
  }

  async generate(
    input: ComposeGenerationRequirements,
    signal: AbortSignal,
  ): Promise<ComposeProviderResult> {
    return withinComposeDeadline(signal, this.deadlineMs, async (bounded) => {
      this.assertConfigured();
      const started = performance.now();
      const requestId = randomUUID();
      let httpAttempt = 0;
      const log = async (
        direction: "request" | "response",
        body: string | null,
        metadata: Partial<LlmBodyRecord> = {},
      ) => {
        if (!this.options.bodyLog) return;
        try {
          await this.options.bodyLog.write(
            {
              identity: input.identity,
              requestId,
              attempt: httpAttempt,
              direction,
              body,
              complete: true,
              truncated: false,
              bytes: body === null ? 0 : Buffer.byteLength(body),
              ...metadata,
            },
            [this.options.apiKey!],
          );
        } catch {
          throw new ComposeProviderFailure("PROVIDER_LOG_FAILED");
        }
      };
      const client = new OpenAI({
        apiKey: this.options.apiKey!,
        baseURL: this.options.baseURL!,
        organization: null,
        project: null,
        maxRetries: 0,
        timeout: this.deadlineMs,
        logLevel: "off",
        fetch: async (url, init) => {
          httpAttempt++;
          const requestBody = typeof init?.body === "string" ? init.body : "";
          if (Buffer.byteLength(requestBody) > COMPOSE_POLICY.maxOutputBytes)
            throw new ComposeProviderFailure("OUTPUT_TOO_LARGE");
          await log("request", requestBody);
          let response: Response;
          try {
            bounded.throwIfAborted();
            const pending = this.request(url, { ...init, redirect: "error" });
            void pending.then(
              (late) => {
                if (bounded.aborted) void discard(late);
              },
              () => {},
            );
            response = await abortable(pending, bounded);
          } catch (error) {
            await log("response", null, {
              complete: false,
              failure:
                error instanceof ComposeProviderFailure
                  ? error.code
                  : "PROVIDER_UNAVAILABLE",
            });
            throw error;
          }
          if (!this.options.bodyLog && response.ok) return response;
          if (!this.options.bodyLog) {
            void discard(response);
          } else {
            try {
              const bytes = await boundedBody(
                response,
                bounded,
                (body, metadata) =>
                  log("response", body, {
                    ...metadata,
                    status: response.status,
                  }),
              );
              if (response.ok)
                return new Response(
                  bytes.length ? new Uint8Array(bytes) : null,
                  { status: response.status, headers: response.headers },
                );
            } catch (error) {
              // Keep the original HTTP failure for an oversized error body.
              if (
                response.ok ||
                !(error instanceof ComposeProviderFailure) ||
                error.code !== "OUTPUT_TOO_LARGE"
              )
                throw error;
            }
          }
          const headers = new Headers();
          const retryAfter = response.headers.get("retry-after");
          if (retryAfter !== null) headers.set("retry-after", retryAfter);
          return new Response(null, { status: response.status, headers });
        },
      });
      const body = {
        ...COMPLETION_PARAMETERS,
        model: this.model,
        messages: composeMessages(input),
      };
      for (let attempt = 0; attempt < MAX_HTTP_ATTEMPTS; attempt++) {
        let response: Response | undefined;
        let headers: Headers | undefined;
        let retry = false;
        let failure: ComposeProviderFailureCode = "PROVIDER_UNAVAILABLE";
        try {
          response = await abortable(
            client.chat.completions
              .create(body, { signal: bounded })
              .asResponse(),
            bounded,
          );
          headers = response.headers;
        } catch (error) {
          if (error instanceof ComposeProviderFailure) throw error;
          if (
            error instanceof OpenAI.APIConnectionError &&
            error.cause instanceof ComposeProviderFailure
          )
            throw error.cause;
          if (error instanceof OpenAI.APIError && error.status !== undefined) {
            failure = failureForStatus(error.status);
            retry = transient(error.status);
            headers = error.headers;
          } else {
            retry = true; // Network exception only; its details never escape.
          }
        }
        if (response) {
          if (!response.ok) {
            failure = failureForStatus(response.status);
            retry = transient(response.status);
            void discard(response);
          } else {
            const value = await boundedJson(response, bounded);
            if (record(value) && record(value.error)) {
              const status = value.error.code;
              if (
                typeof status !== "number" ||
                !Number.isInteger(status) ||
                status < 400 ||
                status > 599
              )
                throw new ComposeProviderFailure("PROVIDER_INVALID_RESPONSE");
              failure = failureForStatus(status);
              retry = transient(status);
            } else {
              const completion = readCompletion(value, this.model);
              return {
                ...completion,
                elapsedMs: Math.round(performance.now() - started),
                httpAttempts: attempt + 1,
              };
            }
          }
        }
        if (!retry || attempt === MAX_HTTP_ATTEMPTS - 1)
          throw new ComposeProviderFailure(failure);
        const wait = retryWait(headers, attempt);
        // Never shorten a provider's Retry-After and retry prematurely.
        if (wait > MAX_RETRY_WAIT_MS) throw new ComposeProviderFailure(failure);
        await abortable(delay(wait, undefined, { signal: bounded }), bounded);
      }
      throw new ComposeProviderFailure("PROVIDER_UNAVAILABLE");
    });
  }
}
