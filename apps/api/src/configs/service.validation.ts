import { BadRequestException } from "@nestjs/common";
import type { ConfigServiceInput } from "@docker-image-creator/contracts";

export function validateServices(services: ConfigServiceInput[]): void {
  const names = new Set<string>();
  const ports = new Set<number>();
  for (const service of services) {
    const database = service.image === "mysql" || service.image === "mongodb";
    if (
      names.has(service.name) ||
      database !== (service.type === "database") ||
      (database && service.language !== undefined) ||
      (!database && service.database !== undefined) ||
      (service.language !== undefined &&
        service.language !==
          (service.image === "node" ? "javascript" : "python")) ||
      (service.hostPort !== undefined && ports.has(service.hostPort))
    ) {
      throw new BadRequestException(
        "Service settings conflict with the catalog",
      );
    }
    names.add(service.name);
    if (service.hostPort !== undefined) ports.add(service.hostPort);
  }
}
