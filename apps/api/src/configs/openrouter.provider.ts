import { setTimeout as delay } from "node:timers/promises";
import type { ComposeGenerationRequirements } from "@docker-image-creator/contracts";
import { COMPOSE_POLICY } from "./compose.policy";
import { composeMessages } from "./compose.prompt";
import {
  abortable,
  COMPOSE_GENERATION_MS,
  COMPOSE_MODEL,
  ComposeGenerationProvider,
  ComposeProviderFailure,
  type ComposeProviderFailureCode,
  type ComposeProviderResult,
  type ComposeValidationCode,
  withinComposeDeadline,
} from "./compose.provider";

export const OPENROUTER_ENDPOINT =
  "https://openrouter.ai/api/v1/chat/completions";
export const OPENROUTER_PARAMETERS = {
  model: COMPOSE_MODEL,
  stream: false,
  temperature: 0.2,
  max_tokens: 16384,
  // No model list, router, paid fallback, plugin, tool, or response-healing path.
  provider: { max_price: { prompt: 0, completion: 0, request: 0 } },
} as const;

const MAX_HTTP_ATTEMPTS = 3;
// JSON escaping/metadata can exceed the content's UTF-8 length.
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_RETRY_WAIT_MS = 30000;

export interface OpenRouterOptions {
  apiKey?: string;
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

function retryWait(response: Response | undefined, attempt: number): number {
  const header = response?.headers.get("retry-after");
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

async function boundedJson(
  response: Response,
  signal: AbortSignal,
): Promise<unknown> {
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) {
    void discard(response);
    throw new ComposeProviderFailure("OUTPUT_TOO_LARGE");
  }
  if (!response.body)
    throw new ComposeProviderFailure("PROVIDER_INVALID_RESPONSE");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await abortable(reader.read(), signal);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES)
        throw new ComposeProviderFailure("OUTPUT_TOO_LARGE");
      chunks.push(chunk.value);
    }
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch (error) {
    void reader.cancel().catch(() => {});
    if (error instanceof ComposeProviderFailure) throw error;
    throw new ComposeProviderFailure("PROVIDER_INVALID_RESPONSE");
  } finally {
    reader.releaseLock();
  }
}

function readCompletion(
  value: unknown,
): Omit<ComposeProviderResult, "elapsedMs" | "httpAttempts"> {
  if (
    !record(value) ||
    !Array.isArray(value.choices) ||
    value.choices.length !== 1
  )
    throw new ComposeProviderFailure("PROVIDER_INVALID_RESPONSE");
  // OpenRouter can report the base slug for a pinned free route. Preserve it;
  // reject every other model. The request still pins :free and zero pricing.
  if (
    value.model !== COMPOSE_MODEL &&
    value.model !== COMPOSE_MODEL.replace(/:free$/, "")
  )
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
    choice.message.tool_calls !== undefined
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
    provider: "openrouter",
    model: COMPOSE_MODEL,
    reportedModel: value.model,
    usage,
  };
}

/** Direct complete-document generation only; no parsing, rendering or execution. */
export class OpenRouterGenerationProvider extends ComposeGenerationProvider {
  private readonly request: typeof fetch;
  private readonly deadlineMs: number;

  constructor(private readonly options: OpenRouterOptions) {
    super();
    this.request = options.fetch ?? fetch;
    this.deadlineMs = Math.min(
      options.deadlineMs ?? COMPOSE_GENERATION_MS,
      COMPOSE_GENERATION_MS,
    );
  }

  async generate(
    input: ComposeGenerationRequirements,
    signal: AbortSignal,
    repair?: ComposeValidationCode,
  ): Promise<ComposeProviderResult> {
    return withinComposeDeadline(signal, this.deadlineMs, async (bounded) => {
      const key = this.options.apiKey;
      if (!key || !key.trim() || /[\r\n]/.test(key))
        throw new ComposeProviderFailure("PROVIDER_NOT_CONFIGURED");
      const started = performance.now();
      const body = JSON.stringify({
        ...OPENROUTER_PARAMETERS,
        messages: composeMessages(input, repair),
      });
      for (let attempt = 0; attempt < MAX_HTTP_ATTEMPTS; attempt++) {
        let response: Response | undefined;
        let retry = false;
        let failure: ComposeProviderFailureCode = "PROVIDER_UNAVAILABLE";
        try {
          const pending = this.request(OPENROUTER_ENDPOINT, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${key}`,
              "Content-Type": "application/json",
            },
            body,
            signal: bounded,
            redirect: "error",
          });
          // Also release a late response from an injected transport after cancellation.
          void pending.then(
            (late) => {
              if (bounded.aborted) void discard(late);
            },
            () => {},
          );
          response = await abortable(pending, bounded);
        } catch (error) {
          if (error instanceof ComposeProviderFailure) throw error;
          retry = true; // Network exception only; its details never escape.
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
              const completion = readCompletion(value);
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
        const wait = retryWait(response, attempt);
        // Never shorten a provider's Retry-After and retry prematurely.
        if (wait > MAX_RETRY_WAIT_MS) throw new ComposeProviderFailure(failure);
        await abortable(delay(wait, undefined, { signal: bounded }), bounded);
      }
      throw new ComposeProviderFailure("PROVIDER_UNAVAILABLE");
    });
  }
}
