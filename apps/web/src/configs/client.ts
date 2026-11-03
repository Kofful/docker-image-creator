import type {
  ConfigResponse,
  CreateConfigRequest,
  CreateConfigResponse,
  GenerationResponse,
  RuntimeAcceptedResponse,
} from "@docker-image-creator/contracts";
import { AuthError } from "../auth/session";

export type ApiRequest = (
  path: string,
  init?: RequestInit,
) => Promise<Response>;

export function createConfigsClient(request: ApiRequest) {
  async function create(
    input: CreateConfigRequest,
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<CreateConfigResponse> {
    // Do not automatically repeat POST after a lost response: discover jobs via list.
    return (
      await request("/api/v1/configs", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body: JSON.stringify(input),
      })
    ).json();
  }
  async function get(
    id: string,
    signal?: AbortSignal,
  ): Promise<ConfigResponse> {
    return (
      await request(`/api/v1/configs/${encodeURIComponent(id)}`, { signal })
    ).json();
  }
  async function list(): Promise<ConfigResponse[]> {
    return (await request("/api/v1/configs")).json();
  }
  async function remove(
    id: string,
    key: string,
    signal?: AbortSignal,
  ): Promise<RuntimeAcceptedResponse | null> {
    const response = await request(
      `/api/v1/configs/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
        headers: { "Idempotency-Key": key },
        signal,
      },
    );
    return response.status === 202 ? response.json() : null;
  }
  async function poll(
    id: string,
    options: {
      signal: AbortSignal;
      onStatus: (value: GenerationResponse) => void;
      onConnectionChange?: (retrying: boolean) => void;
      intervalMs?: number;
    },
  ): Promise<GenerationResponse> {
    let failures = 0;
    while (true) {
      options.signal.throwIfAborted();
      try {
        const result: GenerationResponse = await (
          await request(`/api/v1/generations/${encodeURIComponent(id)}`, {
            signal: options.signal,
          })
        ).json();
        if (
          result.id !== id ||
          !["queued", "running", "succeeded", "failed"].includes(result.status)
        )
          throw new AuthError(0);
        options.signal.throwIfAborted();
        failures = 0;
        options.onConnectionChange?.(false);
        options.onStatus(result);
        if (result.status === "succeeded" || result.status === "failed")
          return result;
      } catch (error) {
        options.signal.throwIfAborted();
        if (
          error instanceof AuthError &&
          error.status !== 0 &&
          error.status !== 429 &&
          error.status < 500
        )
          throw error;
        failures += 1;
        options.onConnectionChange?.(true);
      }
      // Only individual HTTP requests time out. Multi-minute jobs have no client
      // wall-clock timeout, and temporary network/server failures resume polling.
      await pause(
        Math.min(
          30000,
          (options.intervalMs ?? 2000) * 2 ** Math.min(failures, 4),
        ),
        options.signal,
      );
    }
  }
  return { create, get, list, remove, poll };
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const cancel = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, ms);
    signal.addEventListener("abort", cancel, { once: true });
  });
}
