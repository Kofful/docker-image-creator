import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { ComposeGenerationRequirements } from "@docker-image-creator/contracts";
import { isDeepStrictEqual } from "node:util";
import { Prisma } from "../generated/prisma/client";
import { ComposeGenerator } from "./compose.generator";
import { composeIdentity } from "./compose.revision";
import {
  validateCompose,
  validateComposeRequirements,
} from "./compose.validator";
import {
  ComposeProviderFailure,
  ComposeValidationFailure,
  type ComposeProviderResult,
} from "./compose.provider";
import { PrismaService } from "../database/prisma.service";
import { GenerationSettings } from "./generation.settings";
import { SecretBox } from "./secret-box";
import { ArtifactStore } from "./artifact.store";
import { ConfigArtifactCleanup } from "./config-artifact-cleanup";

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
    private readonly settings: GenerationSettings,
    private readonly box: SecretBox,
    private readonly files: ArtifactStore,
    private readonly configCleanup: ConfigArtifactCleanup,
    private readonly composeGenerator: ComposeGenerator,
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
          config: { inputVersion: 2 },
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
        where: {
          status: "running",
          leaseExpiresAt: { lt: now },
          config: { inputVersion: 2 },
        },
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
          config: { deletedAt: null, inputVersion: 2 },
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
        >`SELECT g.id FROM generation_attempts g JOIN configurations c ON c.id = g.config_id WHERE g.status = 'queued' AND c.input_version = 2 AND c.deleted_at IS NULL ORDER BY g.created_at, g.id LIMIT 1 FOR UPDATE SKIP LOCKED`;
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
      if (job.config.inputVersion !== 2) throw new JobFailure("INVALID_INPUT");
      const input = JSON.parse(
        this.box.open(job.inputEncrypted, id),
      ) as ComposeGenerationRequirements;
      validateComposeRequirements(
        input,
        composeIdentity(job.config.userId, job.configId, revisionId),
      );
      const storedValues = await this.prisma.suppliedEnvironmentValue.findMany({
        where: { configId: job.configId },
        select: {
          reference: true,
          purpose: true,
          bindings: { select: { service: true, name: true } },
        },
      });
      const canonical = (
        entries: ComposeGenerationRequirements["environment"],
      ) =>
        entries
          .map((entry) => ({
            reference: entry.reference,
            purpose: entry.purpose,
            bindings: entry.bindings
              .map((binding) => ({
                service: binding.service,
                name: binding.name,
              }))
              .sort((a, b) =>
                `${a.service}:${a.name}`.localeCompare(
                  `${b.service}:${b.name}`,
                ),
              ),
          }))
          .sort((a, b) => a.reference.localeCompare(b.reference));
      if (
        !isDeepStrictEqual(input.services, job.config.services) ||
        !isDeepStrictEqual(
          canonical(input.environment),
          canonical(storedValues),
        )
      )
        throw new JobFailure("INVALID_INPUT");
      const captured: string[] = [];
      const metadata: Prisma.InputJsonObject[] = [];
      const result = await this.composeGenerator.generateValidated(
        input,
        abort.signal,
        (raw) => validateCompose(raw, input),
        async (response: ComposeProviderResult) => {
          abort.signal.throwIfAborted();
          const oversized =
            Buffer.byteLength(response.compose) > this.settings.maxOutputBytes;
          captured.push(
            Buffer.from(response.compose)
              .subarray(0, this.settings.maxOutputBytes)
              .toString("utf8"),
          );
          metadata.push({
            provider: response.provider,
            model: response.model,
            reportedModel: response.reportedModel,
            elapsedMs: response.elapsedMs,
            httpAttempts: response.httpAttempts,
            usage: { ...response.usage },
          });
          const stored = await this.prisma.generationAttempt.updateMany({
            where: owned,
            data: {
              outputEncrypted: this.box.seal(
                JSON.stringify(
                  captured.map((raw) => Buffer.from(raw).toString("base64")),
                ),
                id,
              ),
              outputTruncated: oversized,
              providerResponses: metadata,
              provider: response.provider,
              model: response.model,
              stage: "validating",
            },
          });
          if (!stored.count) throw new JobFailure("INTERRUPTED");
          if (oversized) throw new JobFailure("OUTPUT_TOO_LARGE");
        },
      );
      const direct = result.value;
      const compose = direct.compose;
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
          where: {
            ...owned,
            leaseExpiresAt: { gt: new Date() },
            deadlineAt: { gt: new Date() },
          },
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
            spec: JSON.parse(
              JSON.stringify(direct.metadata),
            ) as Prisma.InputJsonValue,
            compose,
            digest: direct.digest,
            artifactPath,
          },
        });
      });
      wroteFile = false; // The committed revision now owns the file.
    } catch (error) {
      const code = abort.signal.aborted
        ? abort.signal.reason instanceof JobFailure
          ? abort.signal.reason.code
          : "INTERRUPTED"
        : error instanceof JobFailure ||
            error instanceof ComposeProviderFailure ||
            error instanceof ComposeValidationFailure
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
