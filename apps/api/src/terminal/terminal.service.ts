import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { TerminalTicketResponse } from "@docker-image-creator/contracts";
import type { TerminalTicket } from "../generated/prisma/client";
import type { AuthPrincipal } from "../auth/auth.service";
import { PrismaService } from "../database/prisma.service";
import {
  savedRuntimeRevision,
  runtimeEnvironmentSelect,
} from "../runtime/runtime.manifest";
import type { RuntimeTarget } from "../runtime/runtime.driver";
import { socketPath } from "./terminal.protocol";

const hash = (token: string) =>
  createHash("sha256").update(token).digest("hex");

@Injectable()
export class TerminalService {
  constructor(private readonly prisma: PrismaService) {}

  async issue(
    principal: AuthPrincipal,
    configId: string,
    service: string,
  ): Promise<TerminalTicketResponse> {
    const config = await this.prisma.configuration.findFirst({
      where: { id: configId, userId: principal.user.id, deletedAt: null },
      include: { deployment: true },
    });
    if (!config) throw new NotFoundException();
    if (
      config.deletionRequestedAt ||
      !config.deployment ||
      ["starting", "stopping", "stopped"].includes(config.deployment.state)
    )
      throw new ConflictException("Start the container before connecting");
    const token = randomBytes(32).toString("base64url");
    const ticket: TerminalTicket = {
      id: randomUUID(),
      tokenHash: hash(token),
      userId: principal.user.id,
      sessionId: principal.sessionId,
      configId,
      service,
      revisionId: config.deployment.revisionId,
      operationId: config.deployment.operationId,
      expiresAt: new Date(Date.now() + 30000),
      usedAt: null,
    };
    const target = await this.authorize(ticket);
    if (!target.services.some((item) => item.name === service))
      throw new NotFoundException();
    await this.prisma.terminalTicket.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    await this.prisma.terminalTicket.create({ data: ticket });
    return {
      ticket: token,
      expiresAt: ticket.expiresAt.toISOString(),
      socketPath,
    };
  }

  async consume(token: string): Promise<TerminalTicket> {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new UnauthorizedException();
    const ticket = await this.prisma.terminalTicket.findUnique({
      where: { tokenHash: hash(token) },
    });
    if (!ticket) throw new UnauthorizedException();
    const used = await this.prisma.terminalTicket.updateMany({
      where: { id: ticket.id, usedAt: null, expiresAt: { gt: new Date() } },
      data: { usedAt: new Date() },
    });
    if (used.count !== 1) throw new UnauthorizedException();
    await this.authorize(ticket);
    return ticket;
  }

  async authorize(ticket: TerminalTicket): Promise<RuntimeTarget> {
    const session = await this.prisma.session.findFirst({
      where: {
        id: ticket.sessionId,
        userId: ticket.userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
    });
    if (!session) throw new UnauthorizedException();
    const config = await this.prisma.configuration.findFirst({
      where: {
        id: ticket.configId,
        userId: ticket.userId,
        deletedAt: null,
        deletionRequestedAt: null,
      },
      include: {
        deployment: { include: { revision: true } },
        environmentValues: { select: runtimeEnvironmentSelect },
      },
    });
    const deployment = config?.deployment;
    if (
      !deployment ||
      deployment.revision.configId !== ticket.configId ||
      deployment.revisionId !== ticket.revisionId ||
      deployment.operationId !== ticket.operationId ||
      ["starting", "stopping", "stopped"].includes(deployment.state)
    )
      throw new ConflictException();
    if (
      await this.prisma.runtimeOperation.count({
        where: {
          configId: ticket.configId,
          status: { in: ["queued", "running"] },
        },
      })
    )
      throw new ConflictException();
    let saved;
    try {
      saved = savedRuntimeRevision(config!, deployment.revision);
    } catch {
      throw new ConflictException(
        "The saved revision failed execution validation",
      );
    }
    if (!saved.services.some((item) => item.name === ticket.service))
      throw new NotFoundException();
    if (
      deployment.manifest !== saved.manifest ||
      deployment.digest !== saved.digest
    )
      throw new ConflictException();
    return {
      userId: ticket.userId,
      configId: ticket.configId,
      revisionId: ticket.revisionId,
      ...saved,
      secrets: {},
    };
  }

  async cleanupTarget(ticket: TerminalTicket): Promise<RuntimeTarget> {
    const revision = await this.prisma.configRevision.findFirst({
      where: {
        id: ticket.revisionId,
        configId: ticket.configId,
        config: { userId: ticket.userId },
      },
      include: {
        config: {
          include: { environmentValues: { select: runtimeEnvironmentSelect } },
        },
      },
    });
    if (!revision) throw new NotFoundException();
    const saved = savedRuntimeRevision(revision.config, revision);
    return {
      userId: ticket.userId,
      configId: ticket.configId,
      revisionId: ticket.revisionId,
      ...saved,
      secrets: {},
    };
  }
}
