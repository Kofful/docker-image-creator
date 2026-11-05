import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
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
import { validateServices } from "./compose.compiler";
import { ConfigArtifactCleanup } from "./config-artifact-cleanup";
import { GenerationSettings } from "./generation.settings";
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
    QUEUE_EXPIRED: "Generation could not start before its queue deadline.",
  };
  return {
    id: row.id,
    configId: row.configId,
    status: row.status,
    stage: row.stage,
    provider: "fake",
    error: row.errorCode
      ? {
          code: row.errorCode,
          message: messages[row.errorCode] ?? "Generation failed.",
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
    if (
      !versioned &&
      (("environmentValues" in input &&
        input.environmentValues !== undefined) ||
        ("environmentBindings" in input &&
          input.environmentBindings !== undefined))
    )
      throw new BadRequestException(
        "Environment values require inputVersion 2",
      );
    if (versioned) {
      const error = environmentInputError(versioned);
      if (error) throw new BadRequestException(error);
      if (!this.settings.suppliedEnvironmentEnabled)
        throw new ServiceUnavailableException(
          "Supplied environment generation is not available yet",
        );
    }
    const configId = randomUUID();
    const generationId = randomUUID();
    // Keyed digest prevents offline guesses of supplied passwords from DB hashes.
    const inputDigest = versioned
      ? this.box.fingerprint(JSON.stringify(input))
      : createHash("sha256").update(JSON.stringify(input)).digest("hex");
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
      const prepared = versioned
        ? prepareComposeInput(
            userId,
            configId,
            generationId,
            versioned,
            this.box,
          )
        : null;
      await tx.configuration.create({
        data: {
          id: configId,
          userId,
          requestKey,
          inputDigest,
          name: input.name.trim(),
          description: input.description ?? "",
          services: input.services.map((service) => ({ ...service })),
          inputVersion: versioned ? 2 : 1,
          generations: {
            create: {
              id: generationId,
              inputEncrypted: this.box.seal(
                JSON.stringify(prepared?.requirements ?? input),
                generationId,
              ),
            },
          },
        },
      });
      for (const value of prepared?.values ?? []) {
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
