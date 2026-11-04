import {
  Injectable,
  type OnModuleDestroy,
  UnauthorizedException,
} from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { StringDecoder } from "node:string_decoder";
import { WebSocket, WebSocketServer } from "ws";
import type {
  TerminalEndReason,
  TerminalServerMessage,
} from "@docker-image-creator/contracts";
import { DockerRuntimeDriver } from "../runtime/runtime.driver";
import { TerminalService } from "./terminal.service";
import { DockerExec, shellMissing } from "./docker-exec";
import {
  bufferBytes,
  frameBytes,
  heartbeat,
  parseClientMessage,
  sendSocket,
} from "./terminal.protocol";
import type { TerminalTicket } from "../generated/prisma/client";

@Injectable()
export class TerminalRunner implements OnModuleDestroy {
  private server?: Server;
  private readonly sockets = new WebSocketServer({
    noServer: true,
    maxPayload: frameBytes,
    perMessageDeflate: false,
  });
  private readonly cleanups = new Set<Promise<void>>();
  private readonly opening = new Set<Promise<void>>();
  private closing = false;
  constructor(
    private readonly terminal: TerminalService,
    private readonly docker: DockerRuntimeDriver,
    private readonly engine: DockerExec,
  ) {}

  async listen(port = 3001, host = "0.0.0.0"): Promise<number> {
    this.server = createServer((_request, response) => {
      response.writeHead(404).end();
    });
    this.server.on("upgrade", (request, socket, head) => {
      socket.on("error", () => socket.destroy());
      const token = request.headers.authorization?.match(
        /^Bearer ([A-Za-z0-9_-]{43})$/,
      )?.[1];
      if (
        this.closing ||
        request.url !== "/terminal" ||
        request.headers.origin ||
        !token
      ) {
        socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      void this.terminal
        .consume(token)
        .then((ticket) => {
          if (socket.destroyed || this.closing) {
            socket.destroy();
            return;
          }
          this.sockets.handleUpgrade(request, socket, head, (client) => {
            const opening = this.connect(client, ticket);
            this.opening.add(opening);
            void opening.finally(() => this.opening.delete(opening));
          });
        })
        .catch(() =>
          socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"),
        );
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, host, resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === "string")
      throw new Error("Terminal listener failed");
    return address.port;
  }

  private async connect(
    client: WebSocket,
    ticket: TerminalTicket,
  ): Promise<void> {
    let closed = false;
    let stream: Awaited<ReturnType<DockerExec["open"]>> | undefined;
    let container = "";
    let checking = false;
    let interval: NodeJS.Timeout | undefined;
    let queuedBytes = 0;
    let queue = Promise.resolve();
    const stopHeartbeat = heartbeat(client);
    const send = (message: TerminalServerMessage) => {
      if (!sendSocket(client, JSON.stringify(message)))
        finish("output_overflow");
    };
    const cleanup = async () => {
      if (!stream) return;
      stream.socket.destroy();
      try {
        // Recheck container labels/policy before issuing a cleanup exec, even after logout.
        const target = await this.terminal.cleanupTarget(ticket);
        if (
          (await this.docker.terminalContainer(target, ticket.service)) ===
          container
        )
          await this.engine.terminate(container, stream.id, stream.pid);
      } catch {
        /* Container stopped, daemon unavailable, or ownership/policy changed. Never broaden cleanup. */
      }
    };
    const scheduleCleanup = () => {
      const pending = cleanup();
      this.cleanups.add(pending);
      void pending.finally(() => this.cleanups.delete(pending));
    };
    const finish = (reason: TerminalEndReason) => {
      if (closed) return;
      closed = true;
      clearInterval(interval);
      stopHeartbeat();
      sendSocket(
        client,
        JSON.stringify({
          type: "exit",
          reason,
        } satisfies TerminalServerMessage),
      );
      client.close(1000);
      scheduleCleanup();
    };
    client.on("error", () => finish("connection_lost"));
    client.once("close", () => finish("disconnected"));
    client.on("message", (data, binary) => {
      const text = data.toString();
      const size = Buffer.byteLength(text);
      queuedBytes += size;
      if (binary || queuedBytes > bufferBytes) {
        finish("connection_failed");
        return;
      }
      queue = queue
        .then(async () => {
          if (closed) return;
          const message = parseClientMessage(text);
          if (message.type === "disconnect") {
            finish("disconnected");
            return;
          }
          if (!stream) throw new Error();
          if (message.type === "resize")
            await this.engine.resize(stream.id, message.cols, message.rows);
          else {
            if (
              stream.socket.writableLength + Buffer.byteLength(message.data) >
              bufferBytes
            )
              throw new Error();
            stream.socket.write(message.data);
          }
        })
        .catch(() => finish("connection_failed"))
        .finally(() => {
          queuedBytes -= size;
        });
    });
    try {
      const target = await this.terminal.authorize(ticket);
      container = await this.docker.terminalContainer(target, ticket.service);
      stream = await this.engine.open(container, randomUUID());
      if (closed) {
        scheduleCleanup();
        return;
      }
      await this.terminal.authorize(ticket);
      if (closed) {
        scheduleCleanup();
        return;
      }
      const decoder = new StringDecoder("utf8");
      const output = (chunk: Buffer) => {
        // Bound individual frames even when Engine emits a large chunk.
        for (let offset = 0; offset < chunk.length && !closed; offset += 8192) {
          const data = decoder.write(chunk.subarray(offset, offset + 8192));
          if (data) send({ type: "output", data });
        }
      };
      stream.socket.on("data", output);
      stream.socket.once("end", () => {
        const data = decoder.end();
        if (data) send({ type: "output", data });
        finish("shell_exited");
      });
      stream.socket.once("close", () => finish("shell_exited"));
      stream.socket.on("error", () => finish("connection_lost"));
      send({ type: "ready", shell: stream.shell });
      output(stream.head);
      if (closed) return;
      stream.socket.resume();
      interval = setInterval(() => {
        if (checking || closed) return;
        checking = true;
        void (async () => {
          try {
            const current = await this.terminal.authorize(ticket);
            if (
              (await this.docker.terminalContainer(current, ticket.service)) !==
              container
            )
              finish("container_unavailable");
          } catch (error) {
            finish(
              error instanceof UnauthorizedException
                ? "authorization_ended"
                : "container_unavailable",
            );
          } finally {
            checking = false;
          }
        })();
      }, 1000);
      interval.unref();
    } catch (error) {
      finish(
        shellMissing(error)
          ? "shell_unavailable"
          : error instanceof UnauthorizedException
            ? "authorization_ended"
            : "container_unavailable",
      );
    }
  }
  async onModuleDestroy() {
    this.closing = true;
    for (const socket of this.sockets.clients) socket.terminate();
    // close events schedule bounded cleanup before the Prisma pools disconnect.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await Promise.allSettled([...this.opening]);
    await Promise.allSettled([...this.cleanups]);
    this.sockets.close();
    if (this.server)
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }
}
