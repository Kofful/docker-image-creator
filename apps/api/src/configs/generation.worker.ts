import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import type { CreateConfigRequest } from "@docker-image-creator/contracts";
import { PrismaService } from "../database/prisma.service";
import { GenerationProvider } from "./generation.provider";
import { GenerationSettings } from "./generation.settings";
import { SecretBox } from "./secret-box";
import { ArtifactStore } from "./artifact.store";
import { ConfigArtifactCleanup } from "./config-artifact-cleanup";
import {
  compileCompose,
  parseCandidate,
  secretNames,
} from "./compose.compiler";

class JobFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

@Injectable()
export class GenerationWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GenerationWorker.name);
  private timer?: ReturnType<typeof setInterval>;
  private scanning = false;
  private scanFinished: Promise<void> = Promise.resolve();
  private stopped = false;
  private readonly active = new Map<
    string,
    { abort: AbortController; promise: Promise<void> }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: GenerationProvider,
    private readonly settings: GenerationSettings,
    private readonly box: SecretBox,
    private readonly files: ArtifactStore,
    private readonly configCleanup: ConfigArtifactCleanup,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, this.settings.pollMs);
    this.timer.unref();
  }
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.scanFinished;
    for (const job of this.active.values())
      job.abort.abort(new JobFailure("INTERRUPTED"));
    await Promise.allSettled(
      [...this.active.values()].map((job) => job.promise),
    );
  }
  async tick(): Promise<void> {
    if (this.scanning || this.stopped) return;
    this.scanning = true;
    let finishScan!: () => void;
    this.scanFinished = new Promise<void>((resolve) => {
      finishScan = resolve;
    });
    try {
      const now = new Date();
      await this.prisma.generationAttempt.updateMany({
        where: {
          status: "queued",
          createdAt: { lt: new Date(now.getTime() - this.settings.queueMs) },
        },
        data: {
          status: "failed",
          stage: "failed",
          errorCode: "QUEUE_EXPIRED",
          completedAt: now,
        },
      });
      // Expired attempts are fenced and never automatically call the provider again.
      await this.prisma.generationAttempt.updateMany({
        where: { status: "running", leaseExpiresAt: { lt: now } },
        data: {
          status: "failed",
          stage: "failed",
          errorCode: "INTERRUPTED",
          completedAt: now,
          cleanupPending: true,
        },
      });
      const cleanup = await this.prisma.generationAttempt.findMany({
        where: {
          status: "failed",
          cleanupPending: true,
          config: { deletedAt: null },
        },
        include: { config: true },
        take: 20,
      });
      for (const row of cleanup) {
        try {
          await this.files.remove(row.config.userId, row.configId, row.id);
          await this.prisma.generationAttempt.update({
            where: { id: row.id },
            data: { cleanupPending: false },
          });
        } catch {
          /* Preserve the recovery marker without logging paths or content. */
        }
      }
      await this.configCleanup.retryPending();
      for (let index = 0; index < 2 && !this.stopped; index++) {
        const job = await this.claim();
        if (!job) break;
        const abort = new AbortController();
        if (this.stopped) abort.abort(new JobFailure("INTERRUPTED"));
        const promise = this.run(job.id, job.token, abort)
          .catch(() => {
            // Never emit provider, database or filesystem exception details.
            this.logger.error(
              "Generation bookkeeping failed; the lease will expire safely",
            );
          })
          .finally(() => {
            this.active.delete(job.id);
          });
        this.active.set(job.id, { abort, promise });
      }
    } catch {
      this.logger.error(
        "Generation queue scan failed; retrying on the next scan",
      );
    } finally {
      this.scanning = false;
      finishScan();
    }
  }
  private async claim(): Promise<{ id: string; token: string } | null> {
    return this.prisma.$transaction(
      async (tx) => {
        const now = new Date();
        const slots = await tx.$queryRaw<
          { id: number }[]
        >`SELECT id FROM generation_slots WHERE lease_expires_at IS NULL OR lease_expires_at < ${now} ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`;
        if (!slots[0]) return null;
        const rows = await tx.$queryRaw<
          { id: string }[]
        >`SELECT g.id FROM generation_attempts g JOIN configurations c ON c.id = g.config_id WHERE g.status = 'queued' AND c.input_version = 1 AND c.deleted_at IS NULL ORDER BY g.created_at, g.id LIMIT 1 FOR UPDATE SKIP LOCKED`;
        if (!rows[0]) return null;
        const id = rows[0].id;
        const token = randomUUID();
        const deadlineAt = new Date(now.getTime() + this.settings.generationMs);
        const leaseExpiresAt = new Date(
          deadlineAt.getTime() + this.settings.leaseGraceMs,
        );
        await tx.generationAttempt.update({
          where: { id },
          data: {
            status: "running",
            stage: "generating",
            leaseToken: token,
            deadlineAt,
            leaseExpiresAt,
          },
        });
        await tx.generationSlot.update({
          where: { id: slots[0].id },
          data: { generationId: id, leaseToken: token, leaseExpiresAt },
        });
        return { id, token };
      },
      { isolationLevel: "ReadCommitted" },
    );
  }
  private async run(
    id: string,
    token: string,
    abort: AbortController,
  ): Promise<void> {
    const job = await this.prisma.generationAttempt.findUniqueOrThrow({
      where: { id },
      include: { config: true },
    });
    const revisionId = id; // Durable identity permits scoped crash recovery.
    let wroteFile = false;
    let stage = "generating";
    const expiry = setTimeout(
      () => abort.abort(new JobFailure("GENERATION_TIMEOUT")),
      Math.max(1, job.deadlineAt!.getTime() - Date.now()),
    );
    expiry.unref();
    const owned = { id, status: "running" as const, leaseToken: token };
    try {
      abort.signal.throwIfAborted();
      const input = JSON.parse(
        this.box.open(job.inputEncrypted, id),
      ) as CreateConfigRequest;
      const interrupted = new Promise<never>((_resolve, reject) => {
        if (abort.signal.aborted) reject(abort.signal.reason);
        else
          abort.signal.addEventListener(
            "abort",
            () => reject(abort.signal.reason),
            { once: true },
          );
      });
      const raw = await Promise.race([
        this.provider.generate(
          { services: input.services, instructions: input.instructions },
          abort.signal,
        ),
        interrupted,
      ]);
      abort.signal.throwIfAborted();
      const oversized =
        Buffer.byteLength(raw, "utf8") > this.settings.maxOutputBytes;
      const bounded = Buffer.from(raw)
        .subarray(0, this.settings.maxOutputBytes)
        .toString("utf8");
      const stored = await this.prisma.generationAttempt.updateMany({
        where: owned,
        data: {
          outputEncrypted: this.box.seal(bounded, id),
          outputTruncated: oversized,
          stage: "validating",
        },
      });
      if (!stored.count) return;
      if (oversized) throw new JobFailure("OUTPUT_TOO_LARGE");
      let services;
      try {
        services = parseCandidate(raw, input.services);
      } catch {
        throw new JobFailure("INVALID_OUTPUT");
      }
      const compose = compileCompose(job.configId, revisionId, services);
      stage = "writing";
      await this.prisma.generationAttempt.updateMany({
        where: owned,
        data: { stage },
      });
      abort.signal.throwIfAborted();
      await this.prisma.$transaction(async (tx) => {
        // Serialize publication with deletion, including stale workers on other processes.
        await tx.$queryRaw`SELECT id FROM configurations WHERE id = ${job.configId} FOR UPDATE`;
        const config = await tx.configuration.findFirst({
          where: { id: job.configId, deletedAt: null },
        });
        if (!config) throw new JobFailure("INTERRUPTED");
        const result = await tx.generationAttempt.updateMany({
          where: { ...owned, leaseExpiresAt: { gt: new Date() } },
          data: {
            status: "succeeded",
            stage: "complete",
            completedAt: new Date(),
          },
        });
        if (!result.count) throw new JobFailure("INTERRUPTED");
        const artifactPath = await this.files.write(
          job.config.userId,
          job.configId,
          revisionId,
          compose,
        );
        wroteFile = true;
        abort.signal.throwIfAborted();
        await tx.configRevision.create({
          data: {
            id: revisionId,
            configId: job.configId,
            generationId: id,
            version: 1,
            spec: {
              schemaVersion: 1,
              catalogVersion: 1,
              services: services.map((service) => ({ ...service })),
            },
            compose,
            digest: createHash("sha256").update(compose).digest("hex"),
            artifactPath,
          },
        });
        for (const service of services)
          for (const name of secretNames(service)) {
            await tx.configSecret.create({
              data: {
                id: randomUUID(),
                configId: job.configId,
                name,
                valueEncrypted: this.box.seal(
                  this.box.password(),
                  `${job.configId}:${name}`,
                ),
              },
            });
          }
      });
      wroteFile = false; // The committed revision now owns the file.
    } catch (error) {
      const code = abort.signal.aborted
        ? abort.signal.reason instanceof JobFailure
          ? abort.signal.reason.code
          : "INTERRUPTED"
        : error instanceof JobFailure
          ? error.code
          : stage === "writing"
            ? "STORAGE_FAILED"
            : "GENERATION_FAILED";
      let cleanupPending = false;
      if (wroteFile || stage === "writing") {
        try {
          await this.files.remove(job.config.userId, job.configId, revisionId);
        } catch {
          cleanupPending = true;
          this.logger.error("An owned generation artifact needs cleanup");
        }
      }
      await this.prisma.generationAttempt.updateMany({
        where: owned,
        data: {
          status: "failed",
          stage: "failed",
          errorCode: code,
          completedAt: new Date(),
          cleanupPending,
        },
      });
    } finally {
      clearTimeout(expiry);
      await this.prisma.generationSlot.updateMany({
        where: { generationId: id, leaseToken: token },
        data: { generationId: null, leaseToken: null, leaseExpiresAt: null },
      });
    }
  }
}
