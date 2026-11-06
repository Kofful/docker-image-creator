import {
  Injectable,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { PrismaService } from "../database/prisma.service";
import { Prisma } from "../generated/prisma/client";
import type { ServiceRuntimeResponse } from "@docker-image-creator/contracts";
import { ArtifactStore } from "../configs/artifact.store";
import { SecretBox } from "../configs/secret-box";
import { savedRuntimeRevision } from "./runtime.manifest";
import {
  RuntimeDriver,
  RuntimeFailure,
  type RuntimeTarget,
} from "./runtime.driver";

function snapshot(services: ServiceRuntimeResponse[] | undefined) {
  return (
    services?.map((service) => ({
      ...service,
      publishedPort: service.publishedPort
        ? { ...service.publishedPort }
        : null,
    })) ?? Prisma.DbNull
  );
}

@Injectable()
export class RuntimeSettings {
  readonly pollMs = 2000;
  readonly operationMs = 8 * 60000;
  readonly leaseGraceMs = 45000;
  readonly queueMs = 15 * 60000;
  readonly concurrency = 2;
}

@Injectable()
export class RuntimeWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RuntimeWorker.name);
  private timer?: ReturnType<typeof setInterval>;
  private scan: Promise<void> | null = null;
  private stopped = false;
  private readonly active = new Map<
    string,
    { abort: AbortController; promise: Promise<void> }
  >();
  constructor(
    private readonly prisma: PrismaService,
    private readonly box: SecretBox,
    private readonly driver: RuntimeDriver,
    private readonly settings: RuntimeSettings,
    private readonly files: ArtifactStore,
  ) {}
  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, this.settings.pollMs);
  }
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    await this.scan;
    for (const task of this.active.values()) task.abort.abort();
    await Promise.allSettled(
      [...this.active.values()].map((task) => task.promise),
    );
  }
  tick(): Promise<void> {
    if (this.stopped || this.scan) return this.scan ?? Promise.resolve();
    this.scan = this.sweep()
      .catch(() => {
        this.logger.error(
          "Runtime scan failed; retrying without releasing reservations",
        );
      })
      .finally(() => {
        this.scan = null;
      });
    return this.scan;
  }
  private async sweep(): Promise<void> {
    const now = new Date();
    // Lease expires after the command deadline plus grace. Never replay a stale Start.
    await this.prisma.runtimeOperation.updateMany({
      where: {
        status: "running",
        leaseExpiresAt: { lt: now },
        config: { inputVersion: 2 },
      },
      data: {
        status: "failed",
        stage: "failed",
        errorCode: "INTERRUPTED",
        cleanupPending: true,
        completedAt: now,
      },
    });
    await this.prisma.runtimeOperation.updateMany({
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
    const idle = await this.prisma.deployment.findMany({
      where: {
        config: {
          deletedAt: null,
          inputVersion: 2,
          runtimeOperations: {
            none: { status: { in: ["queued", "running"] } },
          },
        },
      },
      orderBy: [{ observedAt: "asc" }, { configId: "asc" }],
      take: 20,
    });
    for (const deployment of idle) {
      if (this.stopped) return;
      try {
        const target = await this.target(deployment.operationId, false);
        const state = await this.driver.observe(
          target,
          AbortSignal.timeout(15000),
        );
        await this.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT id FROM users WHERE id = ${target.userId} FOR UPDATE`;
          const current = await tx.deployment.findUnique({
            where: { configId: target.configId },
          });
          if (
            current?.operationId !== deployment.operationId ||
            (await tx.runtimeOperation.count({
              where: {
                configId: target.configId,
                status: { in: ["queued", "running"] },
              },
            }))
          )
            return;
          await tx.deployment.update({
            where: { configId: target.configId },
            data: {
              state:
                state.running === undefined
                  ? "unknown"
                  : state.ready
                    ? "running"
                    : state.running
                      ? "failed"
                      : "stopped",
              observedAt: new Date(),
              serviceObservations: snapshot(state.services),
            },
          });
          if (state.running === false) {
            await tx.runtimeReservation.deleteMany({
              where: { configId: target.configId },
            });
            await tx.runtimePort.deleteMany({
              where: { configId: target.configId },
            });
            await tx.runtimeOperation.updateMany({
              where: {
                id: deployment.operationId,
                status: "failed",
                type: { not: "delete" },
              },
              data: { cleanupPending: false },
            });
          }
        });
      } catch {
        // Unknown state cannot free a user's slot. Advance scan ordering for fairness.
        await this.prisma.deployment.updateMany({
          where: {
            configId: deployment.configId,
            operationId: deployment.operationId,
          },
          data: {
            state: "unknown",
            observedAt: new Date(),
            serviceObservations: Prisma.DbNull,
          },
        });
      }
    }
    while (!this.stopped && this.active.size < this.settings.concurrency) {
      const job = await this.claim();
      if (!job) break;
      const abort = new AbortController();
      const promise = this.run(job.id, job.token, abort)
        .catch(() => {
          this.logger.error(
            "Runtime bookkeeping failed; reservation retained for reconciliation",
          );
        })
        .finally(() => {
          this.active.delete(job.id);
        });
      this.active.set(job.id, { abort, promise });
    }
  }
  private async claim(): Promise<{ id: string; token: string } | null> {
    return this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<
          { id: string }[]
        >`SELECT o.id FROM runtime_operations o JOIN configurations c ON c.id = o.config_id WHERE o.status = 'queued' AND c.input_version = 2 ORDER BY o.created_at, o.id LIMIT 1 FOR UPDATE SKIP LOCKED`;
        if (!rows[0]) return null;
        const token = randomUUID();
        const deadlineAt = new Date(Date.now() + this.settings.operationMs);
        await tx.runtimeOperation.update({
          where: { id: rows[0].id },
          data: {
            status: "running",
            stage: "validating",
            leaseToken: token,
            deadlineAt,
            leaseExpiresAt: new Date(
              deadlineAt.getTime() + this.settings.leaseGraceMs,
            ),
          },
        });
        return { id: rows[0].id, token };
      },
      { isolationLevel: "ReadCommitted" },
    );
  }
  private async target(
    id: string,
    includeSecrets: boolean,
  ): Promise<RuntimeTarget> {
    const operation = await this.prisma.runtimeOperation.findUniqueOrThrow({
      where: { id },
      include: {
        revision: true,
        config: {
          include: {
            deployment: true,
            environmentValues: {
              select: {
                reference: true,
                purpose: true,
                bindings: { select: { service: true, name: true } },
                ...(includeSecrets ? { valueEncrypted: true } : {}),
              },
            },
          },
        },
      },
    });
    if (
      operation.config.deletedAt ||
      operation.config.userId !== operation.userId ||
      operation.revision.configId !== operation.configId
    )
      throw new RuntimeFailure("INVALID_REVISION");
    const saved = savedRuntimeRevision(operation.config, operation.revision);
    if (
      operation.config.deployment?.revisionId !== operation.revisionId ||
      operation.config.deployment.manifest !== saved.manifest ||
      operation.config.deployment.digest !== saved.digest
    )
      throw new RuntimeFailure("INVALID_REVISION");
    const secrets: Record<string, string> = Object.create(null) as Record<
      string,
      string
    >;
    if (includeSecrets) {
      for (const row of operation.config.environmentValues) {
        if (typeof row.valueEncrypted !== "string")
          throw new RuntimeFailure("INVALID_REVISION");
        const value = this.box.open(
          row.valueEncrypted,
          `${operation.configId}:${row.reference}`,
        );
        // Recheck decrypted values before crossing the privileged process boundary.
        if (
          !value.length ||
          Buffer.byteLength(value) > 4096 ||
          /\0|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
            value,
          )
        )
          throw new RuntimeFailure("INVALID_REVISION");
        secrets[row.reference] = value;
      }
      if (
        Object.values(secrets).reduce(
          (sum, value) => sum + Buffer.byteLength(value),
          0,
        ) > 16384
      )
        throw new RuntimeFailure("INVALID_REVISION");
    }
    return {
      userId: operation.userId,
      configId: operation.configId,
      revisionId: operation.revisionId,
      ...saved,
      secrets,
    };
  }

  private async run(
    id: string,
    token: string,
    abort: AbortController,
  ): Promise<void> {
    const job = await this.prisma.runtimeOperation.findUniqueOrThrow({
      where: { id },
    });
    const expiry = setTimeout(
      () => abort.abort(),
      Math.max(0, job.deadlineAt!.getTime() - Date.now()),
    );
    let target: RuntimeTarget | undefined;
    let errorCode: string | null = null;
    let cleanupPending = false;
    let running: boolean | undefined;
    let ready = false;
    let services: ServiceRuntimeResponse[] | undefined;
    try {
      target = await this.target(id, job.type === "start");
      abort.signal.throwIfAborted();
      const fenced = await this.prisma.runtimeOperation.updateMany({
        where: {
          id,
          status: "running",
          leaseToken: token,
          leaseExpiresAt: { gt: new Date() },
        },
        data: {
          stage:
            job.type === "start"
              ? "starting"
              : job.type === "delete"
                ? "deleting"
                : "stopping",
        },
      });
      if (!fenced.count) throw new RuntimeFailure("INTERRUPTED");
      if (job.type === "start") await this.driver.start(target, abort.signal);
      else if (job.type === "delete") {
        await this.driver.remove(target, abort.signal);
        await this.files.removeConfig(job.userId, job.configId);
        abort.signal.throwIfAborted();
      } else await this.driver.stop(target, abort.signal);
      const observed = await this.driver.observe(target, abort.signal);
      abort.signal.throwIfAborted();
      running = observed.running;
      ready = observed.ready;
      services = observed.services;
      if (job.type === "start" ? !ready : running !== false)
        throw new RuntimeFailure(
          job.type === "start"
            ? "START_FAILED"
            : job.type === "delete"
              ? "DELETE_FAILED"
              : "STOP_FAILED",
        );
    } catch (error) {
      errorCode = abort.signal.aborted
        ? "INTERRUPTED"
        : error instanceof RuntimeFailure
          ? error.code
          : job.type === "delete" && target
            ? "DELETE_FAILED"
            : "INVALID_REVISION";
      if (target) {
        try {
          // On shutdown leave a possibly successful Start alone. Reconcile after lease expiry.
          if (
            !this.stopped &&
            job.type === "start" &&
            !["RESOURCE_CONFLICT", "UNSUPPORTED_DOCKER"].includes(errorCode)
          )
            await this.driver.stop(target, AbortSignal.timeout(150000));
          const observed = await this.driver.observe(
            target,
            AbortSignal.timeout(15000),
          );
          running = observed.running;
          ready = observed.ready;
          services = observed.services;
          cleanupPending = job.type === "delete" || running !== false;
        } catch {
          running = undefined;
          ready = false;
          services = undefined;
          cleanupPending = true;
        }
      } else cleanupPending = true;
    } finally {
      clearTimeout(expiry);
      if (target) target.secrets = {};
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${job.userId} FOR UPDATE`;
      const result = await tx.runtimeOperation.updateMany({
        where: {
          id,
          status: "running",
          leaseToken: token,
          leaseExpiresAt: { gt: new Date() },
          ...(!errorCode ? { deadlineAt: { gt: new Date() } } : {}),
        },
        data: {
          status: errorCode ? "failed" : "succeeded",
          stage: errorCode ? "failed" : "complete",
          errorCode,
          cleanupPending,
          completedAt: new Date(),
        },
      });
      if (!result.count) return;
      if (job.type === "delete" && !errorCode) {
        await tx.configuration.update({
          where: { id: job.configId },
          data: { deletedAt: new Date(), cleanupPending: false },
        });
        await tx.generationAttempt.updateMany({
          where: { configId: job.configId, status: "failed" },
          data: { cleanupPending: false },
        });
      }
      await tx.deployment.updateMany({
        where: { configId: job.configId, operationId: id },
        data: {
          state:
            running === undefined
              ? "unknown"
              : ready && !errorCode
                ? "running"
                : running
                  ? "failed"
                  : "stopped",
          observedAt: new Date(),
          serviceObservations: snapshot(services),
        },
      });
      if (running === false) {
        await tx.runtimeReservation.deleteMany({
          where: { configId: job.configId },
        });
        await tx.runtimePort.deleteMany({ where: { configId: job.configId } });
      }
    });
  }
}
