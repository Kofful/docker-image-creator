import { afterEach, describe, expect, it, vi } from "vitest";
import type { GenerationResponse } from "@docker-image-creator/contracts";
import { createConfigsClient } from "../src/configs/client";
import { AuthError } from "../src/auth/session";
import { json } from "./helpers";

const id = "generation-one";
function status(state: GenerationResponse["status"]): GenerationResponse {
  return {
    id,
    configId: "config-one",
    status: state,
    stage: state,
    provider: "fake",
    error: null,
    revisionId: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
    runtimeValidation: "not_performed",
    cleanupPending: false,
  };
}
afterEach(() => vi.useRealTimers());

describe("asynchronous configuration generation", () => {
  it("polls for multiple minutes without a long HTTP request or resubmitting creation", async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const request = vi
      .fn<(path: string, init?: RequestInit) => Promise<Response>>()
      .mockImplementation(async () =>
        json(status(Date.now() - started < 180000 ? "running" : "succeeded")),
      );
    const onStatus = vi.fn();
    const result = createConfigsClient(request).poll(id, {
      signal: new AbortController().signal,
      onStatus,
    });
    await vi.advanceTimersByTimeAsync(182000);
    expect((await result).status).toBe("succeeded");
    expect(request.mock.calls.length).toBeGreaterThan(80);
    expect(onStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: "succeeded" }),
    );
    expect(
      request.mock.calls.every(
        ([path, init]) =>
          path === `/api/v1/generations/${id}` && init?.method !== "POST",
      ),
    ).toBe(true);
  });

  it("recovers from network errors and server failures while retaining the job", async () => {
    vi.useFakeTimers();
    const request = vi
      .fn()
      .mockRejectedValueOnce(new AuthError(0))
      .mockRejectedValueOnce(new AuthError(503))
      .mockResolvedValueOnce(json(status("succeeded")));
    const connection = vi.fn();
    const result = createConfigsClient(request).poll(id, {
      signal: new AbortController().signal,
      onStatus: vi.fn(),
      onConnectionChange: connection,
    });
    await vi.advanceTimersByTimeAsync(20000);
    expect((await result).status).toBe("succeeded");
    expect(connection.mock.calls).toEqual([[true], [true], [false]]);
    expect(
      request.mock.calls.every(
        ([path]) => path === `/api/v1/generations/${id}`,
      ),
    ).toBe(true);
  });

  it("stops on terminal generation failure or lost authorization", async () => {
    const failed = createConfigsClient(async () => json(status("failed")));
    expect(
      (
        await failed.poll(id, {
          signal: new AbortController().signal,
          onStatus: vi.fn(),
        })
      ).status,
    ).toBe("failed");
    const forbidden = createConfigsClient(async () => {
      throw new AuthError(401);
    });
    await expect(
      forbidden.poll(id, {
        signal: new AbortController().signal,
        onStatus: vi.fn(),
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("cancels the polling timer when the view unmounts", async () => {
    vi.useFakeTimers();
    const abort = new AbortController();
    const request = vi.fn(async () => json(status("running")));
    const result = createConfigsClient(request).poll(id, {
      signal: abort.signal,
      onStatus: vi.fn(),
    });
    const rejection = expect(result).rejects.toMatchObject({
      name: "AbortError",
    });
    await vi.advanceTimersByTimeAsync(1);
    abort.abort();
    await rejection;
    await vi.advanceTimersByTimeAsync(60000);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
