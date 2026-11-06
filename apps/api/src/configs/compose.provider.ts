import type { ComposeGenerationRequirements } from "@docker-image-creator/contracts";
import { GenerationProvider } from "./generation.provider";

export const COMPOSE_MODEL = "google/gemma-4-26b-a4b-it:free";
export const COMPOSE_GENERATION_MS = 5 * 60 * 1000;

export interface ComposeProviderResult {
  /** Complete, unmodified model content. Still requires YAML/policy validation. */
  compose: string;
  provider: "openrouter";
  model: typeof COMPOSE_MODEL;
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

// Fixed categories only: never send parser exception messages/values to a model.
export const COMPOSE_VALIDATION_FEEDBACK = {
  INVALID_YAML:
    "Return one YAML mapping without fences, aliases, tags, duplicate keys or extra documents.",
  UNKNOWN_FIELD:
    "Use only the fields allowed by the policy at every nesting level.",
  IDENTITY_MISMATCH:
    "Preserve the exact project, service names and ownership labels supplied in the request.",
  IMAGE_MISMATCH:
    "Use exactly the requested services and pinned catalog images.",
  RESOURCE_POLICY:
    "Include every required container resource, logging and isolation setting exactly.",
  NETWORK_POLICY:
    "Use only the required private stack network with its exact settings and labels.",
  STORAGE_POLICY:
    "Use only the required database named volumes with exact mounts and labels.",
  PORT_POLICY: "Do not publish any ports; omit ports on every service.",
  ENVIRONMENT_POLICY:
    "Preserve every assigned environment binding using its exact required opaque reference; invent no secrets or references.",
  COMMAND_POLICY:
    "Use argument arrays and only tools/libraries already present in the pinned image; no installation or downloads.",
  HEALTH_POLICY:
    "Include an actual readiness health check on every service with the required timing settings.",
  DEPENDENCY_POLICY:
    "Depend only on requested services with service_healthy; avoid self references and cycles.",
} as const;

export type ComposeValidationCode = keyof typeof COMPOSE_VALIDATION_FEEDBACK;

export class ComposeValidationFailure extends Error {
  constructor(readonly code: ComposeValidationCode) {
    super(code);
  }
}

export abstract class ComposeGenerationProvider extends GenerationProvider<
  ComposeGenerationRequirements,
  ComposeProviderResult
> {
  abstract generate(
    input: ComposeGenerationRequirements,
    signal: AbortSignal,
    repair?: ComposeValidationCode,
  ): Promise<ComposeProviderResult>;
}

/** Caller cancellation and all content/transport attempts share this deadline. */
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
