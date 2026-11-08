import type { ComposeGenerationRequirements } from "@docker-image-creator/contracts";
import { GenerationProvider } from "./generation.provider";

export const COMPOSE_GENERATION_MS = 5 * 60 * 1000;

export interface ComposeProviderResult {
  /** Complete, unmodified model content. Still requires YAML/policy validation. */
  compose: string;
  provider: "openai";
  model: string;
  reportedModel: string;
  elapsedMs: number;
  httpAttempts: number;
  usage: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

export type ComposeProviderFailureCode =
  | "PROVIDER_LOG_FAILED"
  | "PROVIDER_NOT_CONFIGURED"
  | "PROVIDER_AUTH_FAILED"
  | "PROVIDER_CREDITS_REQUIRED"
  | "MODEL_UNAVAILABLE"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_REQUEST_FAILED"
  | "PROVIDER_INVALID_RESPONSE"
  | "PROVIDER_MODEL_MISMATCH"
  | "OUTPUT_EMPTY"
  | "OUTPUT_TRUNCATED"
  | "OUTPUT_TOO_LARGE"
  | "GENERATION_TIMEOUT"
  | "INTERRUPTED";

/** Deliberately contains no provider body, exception cause, key, or input. */
export class ComposeProviderFailure extends Error {
  constructor(readonly code: ComposeProviderFailureCode) {
    super(code);
  }
}

export type ComposeValidationCode =
  | "INVALID_YAML"
  | "UNKNOWN_FIELD"
  | "IDENTITY_MISMATCH"
  | "IMAGE_MISMATCH"
  | "RESOURCE_POLICY"
  | "NETWORK_POLICY"
  | "STORAGE_POLICY"
  | "PORT_POLICY"
  | "ENVIRONMENT_POLICY"
  | "COMMAND_POLICY"
  | "HEALTH_POLICY"
  | "DEPENDENCY_POLICY";

export class ComposeValidationFailure extends Error {
  constructor(readonly code: ComposeValidationCode) {
    super(code);
  }
}

export abstract class ComposeGenerationProvider extends GenerationProvider<
  ComposeGenerationRequirements,
  ComposeProviderResult
> {
  readonly model?: string;

  abstract generate(
    input: ComposeGenerationRequirements,
    signal: AbortSignal,
  ): Promise<ComposeProviderResult>;
}

/** The single generation response, capture and transport retries share this deadline. */
export async function withinComposeDeadline<T>(
  parent: AbortSignal,
  durationMs: number,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  if (parent.aborted) throw interruption(parent);
  const controller = new AbortController();
  const cancel = () => controller.abort(interruption(parent));
  parent.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(
    () => controller.abort(new ComposeProviderFailure("GENERATION_TIMEOUT")),
    durationMs,
  );
  try {
    return await abortable(work(controller.signal), controller.signal);
  } finally {
    clearTimeout(timer);
    parent.removeEventListener("abort", cancel);
  }
}

function interruption(signal: AbortSignal): ComposeProviderFailure {
  return signal.reason instanceof ComposeProviderFailure
    ? signal.reason
    : new ComposeProviderFailure("INTERRUPTED");
}

export async function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let cancel: () => void = () => {};
  const interrupted = new Promise<never>((_resolve, reject) => {
    cancel = () => reject(interruption(signal));
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    return await Promise.race([interrupted, promise]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
