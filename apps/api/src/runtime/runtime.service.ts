import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type {
  ConfigServiceInput,
  DeploymentResponse,
  RuntimeAcceptedResponse,
  RuntimeOperationResponse,
} from "@docker-image-creator/contracts";
import { PrismaService } from "../database/prisma.service";
import type { RuntimeOperation } from "../generated/prisma/client";
import { Prisma } from "../generated/prisma/client";
import { compileCompose } from "../configs/compose.compiler";
import { digest, revisionServices, runtimeManifest } from "./runtime.manifest";

const errors: Record<string, string> = {
  IMAGE_PULL_FAILED:
    "An approved image could not be downloaded. Retry after checking registry connectivity.",
  INVALID_REVISION: "The saved revision failed execution validation.",
  UNSUPPORTED_DOCKER:
    "Execution requires Docker Engine 28 or later with isolated bridge support.",
  DOCKER_UNAVAILABLE:
    "The runner could not inspect Docker. Retry after it is available.",
  START_FAILED: "Services could not reach readiness. Data has been preserved.",
  DELETE_FAILED:
    "Cleanup could not be completed. Persistent data is preserved. Retry Delete.",
  STOP_FAILED: "Services could not be verified stopped. Retry Stop.",
  INTERRUPTED:
    "Execution was interrupted. Inspect the deployment and retry explicitly.",
  RESOURCE_CONFLICT: "Docker resources or ports conflict with this deployment.",
  QUEUE_EXPIRED: "Execution did not start within fifteen minutes.",
};
export function operationResponse(
  row: RuntimeOperation,
): RuntimeOperationResponse {
  return {
    id: row.id,
    configId: row.configId,
    revisionId: row.revisionId,
    type: row.type,
    status: row.status,
    stage: row.stage,
    cleanupPending: row.cleanupPending,
    error: row.errorCode
      ? {
          code: row.errorCode,
          message: errors[row.errorCode] ?? "Execution failed.",
        }
      : null,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

@Injectable()
export class RuntimeService {
  constructor(private readonly prisma: PrismaService) {}

  async submit(
    userId: string,
    configId: string,
    type: "start" | "stop",
    requestKey: string,
    revisionId?: string,
  ): Promise<RuntimeAcceptedResponse> {
    configId = configId.toLowerCase();
    revisionId = revisionId?.toLowerCase();
    const operation = await this.prisma
      .$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
          await tx.$queryRaw`SELECT id FROM configurations WHERE id = ${configId} AND user_id = ${userId} FOR UPDATE`;
          const config = await tx.configuration.findFirst({
            where: { id: configId, userId, deletedAt: null },
          });
          if (!config) throw new NotFoundException("Configuration not found");
          if (type === "start" && config.deletionRequestedAt)
            throw new ConflictException(
              "Deletion must finish before this configuration can be started",
            );
          const previous = await tx.runtimeOperation.findUnique({
            where: { userId_requestKey: { userId, requestKey } },
          });
          if (previous) {
            if (
              previous.configId !== configId ||
              previous.type !== type ||
              (revisionId && previous.revisionId !== revisionId)
            )
              throw new ConflictException(
                "Idempotency-Key was already used for another request",
              );
            return previous;
          }
          const deployment = await tx.deployment.findUnique({
            where: { configId },
          });
          if (
            await tx.runtimeOperation.count({
              where: { configId, status: { in: ["queued", "running"] } },
            })
          )
            throw new ConflictException(
              "A runtime operation is already pending",
            );
          if (
            await tx.generationAttempt.count({
              where: { configId, status: { in: ["queued", "running"] } },
            })
          )
            throw new ConflictException("Generation is still in progress");
          const selectedId =
            type === "start" ? revisionId : deployment?.revisionId;
          const revision = selectedId
            ? await tx.configRevision.findFirst({
                where: {
                  id: selectedId,
                  configId,
                  generation: { status: "succeeded" },
                },
              })
            : null;
          if (!revision)
            throw new BadRequestException(
              "A saved successful revision is required",
            );
          let manifest: string;
          let services: ConfigServiceInput[];
          try {
            services = revisionServices(revision.spec);
            if (
              digest(revision.compose) !== revision.digest ||
              compileCompose(configId, revision.id, services) !==
                revision.compose
            )
              throw new Error("INVALID_REVISION");
            manifest = runtimeManifest(userId, configId, revision.id, services);
          } catch {
            throw new BadRequestException(
              "The saved revision failed execution validation",
            );
          }
          if (type === "start") {
            if (
              deployment &&
              deployment.state !== "stopped" &&
              deployment.state !== "failed"
            )
              throw new ConflictException(
                "Stop the existing deployment before starting it again",
              );
            const reservation = await tx.runtimeReservation.findUnique({
              where: { userId },
            });
            if (reservation)
              throw new ConflictException(
                "Your running configuration must be verified stopped first",
              );
            await tx.runtimeReservation.create({ data: { userId, configId } });
            for (const service of services)
              if (service.hostPort !== undefined) {
                const port = await tx.runtimePort.findUnique({
                  where: { port: service.hostPort },
                });
                if (port && port.configId !== configId)
                  throw new ConflictException(
                    "A requested host port is reserved",
                  );
                if (!port)
                  await tx.runtimePort.create({
                    data: { port: service.hostPort, configId },
                  });
              }
          }
          const id = randomUUID();
          const row = await tx.runtimeOperation.create({
            data: {
              id,
              userId,
              configId,
              revisionId: revision.id,
              requestKey,
              type,
            },
          });
          await tx.deployment.upsert({
            where: { configId },
            create: {
              configId,
              revisionId: revision.id,
              operationId: id,
              state: "starting",
              manifest,
              digest: digest(manifest),
            },
            update: {
              operationId: id,
              ...(type === "start"
                ? {
                    revisionId: revision.id,
                    manifest,
                    digest: digest(manifest),
                    state: "starting" as const,
                  }
                : { state: "stopping" as const }),
            },
          });
          return row;
        },
        { isolationLevel: "ReadCommitted" },
      )
      .catch((error: unknown) => {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          ["P2002", "P2034"].includes(error.code)
        )
          throw new ConflictException(
            "A concurrent runtime request reserved these resources. Retry with the same key.",
          );
        throw error;
      });
    return {
      operationId: operation.id,
      statusUrl: `/api/v1/operations/${operation.id}`,
      pollAfterMs: 2000,
    };
  }

  async operation(
    userId: string,
    id: string,
  ): Promise<RuntimeOperationResponse> {
    const row = await this.prisma.runtimeOperation.findFirst({
      where: {
        id,
        userId,
        OR: [{ config: { deletedAt: null } }, { type: "delete" }],
      },
    });
    if (!row) throw new NotFoundException("Operation not found");
    return operationResponse(row);
  }
  async deployment(
    userId: string,
    configId: string,
  ): Promise<DeploymentResponse> {
    const row = await this.prisma.deployment.findFirst({
      where: { configId, config: { userId, deletedAt: null } },
    });
    if (!row) throw new NotFoundException("Deployment not found");
    return {
      configId,
      revisionId: row.revisionId,
      state: row.state,
      operationId: row.operationId,
      observedAt: row.observedAt?.toISOString() ?? null,
    };
  }
}
