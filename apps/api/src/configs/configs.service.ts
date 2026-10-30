import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import type {
  ConfigResponse,
  CreateConfigRequest,
  CreateConfigResponse,
  GenerationResponse,
} from "@docker-image-creator/contracts";
import { PrismaService } from "../database/prisma.service";
import {
  type GenerationAttempt,
  type ConfigRevision,
} from "../generated/prisma/client";
import { SecretBox } from "./secret-box";
import { validateServices } from "./compose.compiler";

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
  ) {}
  async create(
    userId: string,
    input: CreateConfigRequest,
    requestKey: string = randomUUID(),
  ): Promise<CreateConfigResponse> {
    validateServices(input.services);
    const configId = randomUUID();
    const generationId = randomUUID();
    const inputDigest = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    const result = await this.prisma.$transaction(async (tx) => {
      // Serialize admissions for this user across API instances.
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId} FOR UPDATE`;
      const existing = await tx.configuration.findUnique({
        where: { userId_requestKey: { userId, requestKey } },
        include: { generations: { take: 1 } },
      });
      if (existing) {
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
      if ((await tx.configuration.count({ where: { userId } })) >= 20)
        throw new ConflictException("Configuration quota reached");
      await tx.configuration.create({
        data: {
          id: configId,
          userId,
          requestKey,
          inputDigest,
          name: input.name.trim(),
          description: input.description ?? "",
          services: input.services.map((service) => ({ ...service })),
          generations: {
            create: {
              id: generationId,
              inputEncrypted: this.box.seal(
                JSON.stringify(input),
                generationId,
              ),
            },
          },
        },
      });
      return { configId, generationId, status: "queued" as const };
    });
    return {
      ...result,
      statusUrl: `/api/v1/generations/${result.generationId}`,
      pollAfterMs: 2000,
    };
  }
  async generation(userId: string, id: string): Promise<GenerationResponse> {
    const row = await this.prisma.generationAttempt.findFirst({
      where: { id, config: { userId } },
      include: { revision: true },
    });
    if (!row) throw new NotFoundException("Generation not found");
    return generationResponse(row);
  }
  async get(userId: string, id: string): Promise<ConfigResponse> {
    const row = await this.prisma.configuration.findFirst({
      where: { id, userId },
      include: {
        generations: {
          orderBy: { createdAt: "desc" },
          take: 1,
          include: { revision: true },
        },
      },
    });
    if (!row?.generations[0])
      throw new NotFoundException("Configuration not found");
    const generation = row.generations[0];
    const revision = generation.revision;
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      services: row.services as unknown as CreateConfigRequest["services"],
      generation: generationResponse(generation),
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
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 20,
      select: { id: true },
    });
    return Promise.all(rows.map((row) => this.get(userId, row.id)));
  }
}
