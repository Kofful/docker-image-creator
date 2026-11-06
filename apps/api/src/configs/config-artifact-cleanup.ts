import { Injectable } from "@nestjs/common";
import { PrismaService } from "../database/prisma.service";
import { ArtifactStore } from "./artifact.store";

@Injectable()
export class ConfigArtifactCleanup {
  private cursor = "";
  constructor(
    private readonly prisma: PrismaService,
    private readonly files: ArtifactStore,
  ) {}

  async clean(userId: string, configId: string): Promise<void> {
    const config = await this.prisma.configuration.findFirst({
      where: {
        id: configId,
        userId,
        inputVersion: 2,
        deletedAt: { not: null },
        cleanupPending: true,
      },
    });
    if (!config) return;
    try {
      await this.files.removeConfig(userId, configId);
      await this.prisma.$transaction([
        this.prisma.generationAttempt.updateMany({
          where: { configId, status: "failed" },
          data: { cleanupPending: false },
        }),
        this.prisma.configuration.update({
          where: { id: configId },
          data: { cleanupPending: false },
        }),
      ]);
    } catch {
      // Keep the durable marker; never log filesystem paths or stored content.
    }
  }

  async retryPending(): Promise<void> {
    const configs = await this.prisma.configuration.findMany({
      where: {
        deletedAt: { not: null },
        inputVersion: 2,
        cleanupPending: true,
        id: { gt: this.cursor },
      },
      orderBy: { id: "asc" },
      take: 20,
      select: { id: true, userId: true },
    });
    for (const config of configs) await this.clean(config.userId, config.id);
    // Rotate through failures so a persistent bad path cannot starve later IDs.
    this.cursor = configs.length === 20 ? configs[configs.length - 1]!.id : "";
  }
}
