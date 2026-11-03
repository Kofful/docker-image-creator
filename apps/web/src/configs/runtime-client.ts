import type {
  DeploymentResponse,
  ConfigServicesResponse,
  RuntimeAcceptedResponse,
  RuntimeOperationResponse,
} from "@docker-image-creator/contracts";
import { AuthError } from "../auth/session";
import type { ApiRequest } from "./client";

export function createRuntimeClient(request: ApiRequest) {
  async function deployment(
    id: string,
    signal: AbortSignal,
  ): Promise<DeploymentResponse | null> {
    try {
      return await (
        await request(`/api/v1/configs/${encodeURIComponent(id)}/deployment`, {
          signal,
        })
      ).json();
    } catch (error) {
      if (error instanceof AuthError && error.status === 404) return null;
      throw error;
    }
  }

  async function operation(
    id: string,
    signal: AbortSignal,
  ): Promise<RuntimeOperationResponse> {
    return (
      await request(`/api/v1/operations/${encodeURIComponent(id)}`, { signal })
    ).json();
  }

  async function services(
    id: string,
    signal: AbortSignal,
  ): Promise<ConfigServicesResponse> {
    return (
      await request(`/api/v1/configs/${encodeURIComponent(id)}/services`, {
        signal,
      })
    ).json();
  }

  async function submit(
    id: string,
    type: "start" | "stop",
    revisionId: string | undefined,
    key: string,
    signal: AbortSignal,
  ): Promise<RuntimeAcceptedResponse> {
    return (
      await request(`/api/v1/configs/${encodeURIComponent(id)}/${type}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": key,
        },
        body: JSON.stringify(type === "start" ? { revisionId } : {}),
        signal,
      })
    ).json();
  }

  return { deployment, operation, services, submit };
}
