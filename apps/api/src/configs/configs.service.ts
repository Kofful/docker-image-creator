import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type {
  ConfigResponse,
  CreateConfigRequest,
  CreateComposeConfigRequest,
  CreateConfigResponse,
  GenerationResponse,
  RuntimeAcceptedResponse,
} from "@docker-image-creator/contracts";
import { PrismaService } from "../database/prisma.service";
import {
  type Configuration,
  type GenerationAttempt,
  type ConfigRevision,
  type RuntimeOperation,
} from "../generated/prisma/client";
import { operationResponse } from "../runtime/runtime.service";
import { SecretBox } from "./secret-box";
import { validateServices } from "./service.validation";
import { ConfigArtifactCleanup } from "./config-artifact-cleanup";
import { GenerationSettings } from "./generation.settings";
import { COMPOSE_MODEL } from "./compose.provider";
import { prepareComposeInput } from "./compose.environment";
import { environmentInputError } from "@docker-image-creator/contracts";

export function generationResponse(
  row: GenerationAttempt & { revision?: ConfigRevision | null },
): GenerationResponse {
  const messages: Record<string, string> = {
    GENERATION_TIMEOUT: "Generation exceeded its five-minute deadline.",
    INVALID_OUTPUT: "The generated specification failed validation.",
    OUTPUT_TOO_LARGE: "The generated response exceeded the size limit.",
    GENERATION_FAILED: "Generation could not be completed.",
    STORAGE_FAILED: "The Compose file could not be saved.",
    INTERRUPTED: "Generation was interrupted. Create a new attempt to retry.",
    PROVIDER_NOT_CONFIGURED: "The generation provider is not configured.",
    PROVIDER_AUTH_FAILED: "The generation provider rejected its credentials.",
    PROVIDER_CREDITS_REQUIRED:
      "The free model could not be used with the current provider account.",
    MODEL_UNAVAILABLE: "The selected model is unavailable.",
    PROVIDER_RATE_LIMITED: "The generation provider rate limit was reached.",
    PROVIDER_UNAVAILABLE: "The generation provider is unavailable.",
    PROVIDER_REQUEST_FAILED:
      "The generation provider could not complete the request.",
    PROVIDER_INVALID_RESPONSE:
      "The generation provider returned an invalid response.",
    PROVIDER_MODEL_MISMATCH:
      "The generation provider returned a different model.",
    OUTPUT_EMPTY: "The generation provider returned no document.",
    OUTPUT_TRUNCATED:
      "The generation provider returned an incomplete document.",
    INVALID_INPUT: "The stored generation requirements could not be verified.",
    QUEUE_EXPIRED: "Generation could not start before its queue deadline.",
  };
  return {
    id: row.id,
    configId: row.configId,
    status: row.status,
    stage: row.stage,
    provider: row.provider === "openrouter" ? "openrouter" : "fake",
    ...(row.provider === "openrouter" && row.model === COMPOSE_MODEL
      ? { inputVersion: 2 as const, model: COMPOSE_MODEL }
      : {}),
    error: row.errorCode
      ? {
          code: row.errorCode,
          message:
            messages[row.errorCode] ??
            "The generated Compose document failed policy validation.",
        }
      : null,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    revisionId: row.revision?.id ?? null,
    runtimeValidation: "not_performed",
    cleanupPending: row.cleanupPending,
  };
}

@Injectable()
export class ConfigsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly box: SecretBox,
    private readonly cleanup: ConfigArtifactCleanup,
    private readonly settings: GenerationSettings,
  ) {}
  async create(
    userId: string,
    input: CreateConfigRequest | CreateComposeConfigRequest,
    requestKey: string = randomUUID(),
  ): Promise<CreateConfigResponse> {
    validateServices(input.services);
    const versioned =
      "inputVersion" in input && input.inputVersion === 2 ? input : null;
    if (!versioned)
      throw new BadRequestException(
        "Only inputVersion 2 Compose generation is supported",
      );
    const error = environmentInputError(versioned);
    if (error) throw new BadRequestException(error);
    if (!this.settings.suppliedEnvironmentEnabled)
      throw new ServiceUnavailableException(
        "Compose generation is unavailable",
      );
    const configId = randomUUID();
    const generationId = randomUUID();
    // Keyed digest prevents offline guesses of supplied passwords from DB hashes.
    const inputDigest = this.box.fingerprint(JSON.stringify(input));
    const result = await this.prisma.$transaction(async (tx) => {
      // Serialize admissions for this user across API instances.
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      const existing = await tx.configuration.findUnique({
        where: { userId_requestKey: { userId, requestKey } },
        include: { generations: { take: 1 } },
      });
      if (existing) {
        if (existing.deletedAt)
          throw new BadRequestException(
            "Idempotency key belongs to a deleted configuration",
          );
        if (existing.inputDigest !== inputDigest)
          throw new ConflictException(
            "Idempotency key was used with different settings",
          );
        const job = existing.generations[0]!;
        return {
          configId: existing.id,
          generationId: job.id,
          status: job.status,
        };
      }
      const active = await tx.generationAttempt.count({
        where: { config: { userId }, status: { in: ["queued", "running"] } },
      });
      if (active)
        throw new ConflictException(
          "A configuration is already being generated for this user",
        );
      if (
        (await tx.configuration.count({
          where: { userId, deletedAt: null },
        })) >= 20
      )
        throw new ConflictException("Configuration quota reached");
      const prepared = prepareComposeInput(
        userId,
        configId,
        generationId,
        versioned,
        this.box,
      );
      await tx.configuration.create({
        data: {
          id: configId,
          userId,
          requestKey,
          inputDigest,
          name: input.name.trim(),
          description: input.description ?? "",
          services: input.services.map((service) => ({ ...service })),
          inputVersion: 2,
          generations: {
            create: {
              id: generationId,
              provider: "openrouter",
              model: COMPOSE_MODEL,
              inputEncrypted: this.box.seal(
                JSON.stringify(prepared.requirements),
                generationId,
              ),
            },
          },
        },
      });
      for (const value of prepared.values) {
        const { bindings, ...record } = value;
        await tx.suppliedEnvironmentValue.create({ data: record });
        await tx.serviceEnvironmentBinding.createMany({ data: bindings });
      }
      return { configId, generationId, status: "queued" as const };
    });
    return {
      ...result,
      statusUrl: `/api/v1/generations/${result.generationId}`,
      pollAfterMs: 2000,
    };
  }
  async delete(
    userId: string,
    id: string,
    requestKey: string = randomUUID(),
  ): Promise<RuntimeAcceptedResponse | void> {
    id = id.toLowerCase();
    const operation = await this.prisma.$transaction(
      async (tx) => {
        // Use the admission lock so a freed quota slot is visible to new creation.
        await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
        // File publication takes this same lock before writing any artifacts.
        await tx.$queryRaw`SELECT id FROM configurations WHERE id = ${id} AND user_id = ${userId} FOR UPDATE`;
        const config = await tx.configuration.findFirst({
          where: { id, userId },
        });
        if (!config) throw new NotFoundException("Configuration not found");
        const previous = await tx.runtimeOperation.findUnique({
          where: { userId_requestKey: { userId, requestKey } },
        });
        if (previous) {
          if (previous.configId !== id || previous.type !== "delete")
            throw new ConflictException(
              "Idempotency-Key was already used for another request",
            );
          return previous;
        }
        if (config.deletedAt)
          throw new NotFoundException("Configuration not found");
        if (config.inputVersion !== 2)
          throw new BadRequestException(
            "Legacy configurations are unsupported; use the previous version for cleanup",
          );
        const pending = await tx.runtimeOperation.findFirst({
          where: { configId: id, status: { in: ["queued", "running"] } },
        });
        if (pending?.type === "delete") return pending;
        if (pending)
          throw new ConflictException("A runtime operation is already pending");
        const active = await tx.generationAttempt.count({
          where: { configId: id, status: { in: ["queued", "running"] } },
        });
        if (active)
          throw new ForbiddenException(
            "Cannot delete a configuration during generation",
          );
        const deployment = await tx.deployment.findUnique({
          where: { configId: id },
        });
        if (deployment) {
          if (config.inputVersion !== 2)
            throw new BadRequestException(
              "Legacy deployments are unsupported; use the previous version for cleanup",
            );
          if (deployment.state !== "stopped")
            throw new ConflictException(
              "Stop the configuration before deleting it",
            );
          const operation = await tx.runtimeOperation.create({
            data: {
              id: randomUUID(),
              userId,
              configId: id,
              revisionId: deployment.revisionId,
              requestKey,
              type: "delete",
            },
          });
          await tx.configuration.update({
            where: { id },
            data: { deletionRequestedAt: new Date() },
          });
          await tx.deployment.update({
            where: { configId: id },
            data: { operationId: operation.id },
          });
          return operation;
        }
        await tx.configuration.update({
          where: { id },
          data: { deletedAt: new Date(), cleanupPending: true },
        });
      },
      { isolationLevel: "ReadCommitted" },
    );
    if (operation)
      return {
        operationId: operation.id,
        statusUrl: `/api/v1/operations/${operation.id}`,
        pollAfterMs: 2000,
      };
    // Deletion is already durable. A cleanup failure must not resurrect it.
    await this.cleanup.clean(userId, id).catch(() => undefined);
  }
  async generation(userId: string, id: string): Promise<GenerationResponse> {
    const row = await this.prisma.generationAttempt.findFirst({
      where: { id, config: { userId, deletedAt: null } },
      include: { revision: true },
    });
    if (!row) throw new NotFoundException("Generation not found");
    return generationResponse(row);
  }
  async get(userId: string, id: string): Promise<ConfigResponse> {
    const row = await this.prisma.configuration.findFirst({
      where: { id, userId, deletedAt: null },
      include: {
        runtimeOperations: {
          where: { type: "delete" },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 1,
        },
        generations: {
          orderBy: { createdAt: "desc" },
          take: 1,
          include: { revision: true },
        },
      },
    });
    if (!row?.generations[0])
      throw new NotFoundException("Configuration not found");
    return this.response(row);
  }
  private response(
    row: Configuration & {
      runtimeOperations: RuntimeOperation[];
      generations: (GenerationAttempt & { revision: ConfigRevision | null })[];
    },
  ): ConfigResponse {
    const generation = row.generations[0]!;
    const revision = generation.revision;
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      services: row.services as unknown as CreateConfigRequest["services"],
      generation: generationResponse(generation),
      deletion: row.runtimeOperations[0]
        ? operationResponse(row.runtimeOperations[0])
        : null,
      revision:
        generation.status === "succeeded" && revision
          ? {
              id: revision.id,
              version: revision.version,
              compose: revision.compose,
              digest: revision.digest,
              artifactPath: revision.artifactPath,
            }
          : null,
    };
  }
  async list(userId: string): Promise<ConfigResponse[]> {
    const rows = await this.prisma.configuration.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: {
        runtimeOperations: {
          where: { type: "delete" },
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 1,
        },
        generations: {
          orderBy: { createdAt: "desc" },
          take: 1,
          include: { revision: true },
        },
      },
    });
    return rows
      .filter((row) => row.generations.length > 0)
      .map((row) => this.response(row));
  }
}
