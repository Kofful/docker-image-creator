import type {
  ConfigServiceInput,
  ContainerState,
  ServiceRuntimeResponse,
} from "@docker-image-creator/contracts";
import { CATALOG } from "../configs/image.catalog";

export const containerStates = new Set<ContainerState>([
  "not_created",
  "created",
  "running",
  "restarting",
  "paused",
  "exited",
  "dead",
  "removing",
  "unknown",
]);

export function unknownService(
  service: ConfigServiceInput,
): ServiceRuntimeResponse {
  return {
    name: service.name,
    image: CATALOG[service.image].image,
    state: "unknown",
    health: null,
    publishedPort: null,
    observedAt: null,
  };
}

// Pick fields explicitly even from stored snapshots. Never return arbitrary inspect data.
export function serviceObservations(
  services: ConfigServiceInput[],
  value: unknown,
): ServiceRuntimeResponse[] {
  return services.map((service) => {
    const fallback = unknownService(service);
    const matches: unknown[] = Array.isArray(value)
      ? value.filter(
          (row: unknown) =>
            !!row &&
            typeof row === "object" &&
            "name" in row &&
            row.name === service.name,
        )
      : [];
    if (matches.length !== 1) return fallback;
    const row = matches[0] as Record<string, unknown>;
    if (
      row.image !== fallback.image ||
      !containerStates.has(row.state as ContainerState) ||
      row.state === "unknown" ||
      typeof row.observedAt !== "string" ||
      !Number.isFinite(Date.parse(row.observedAt)) ||
      ![null, "starting", "healthy", "unhealthy"].includes(
        row.health as string | null,
      )
    )
      return fallback;
    if (row.publishedPort !== null) return fallback;
    return {
      ...fallback,
      state: row.state as ContainerState,
      health: row.health as ServiceRuntimeResponse["health"],
      publishedPort: null,
      observedAt: row.observedAt,
    };
  });
}
