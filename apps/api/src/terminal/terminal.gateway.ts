import {
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from "@nestjs/common";
import { HttpAdapterHost } from "@nestjs/core";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { AuthConfig } from "../auth/auth.config";
import {
  bufferBytes,
  frameBytes,
  heartbeat,
  sendSocket,
  socketPath,
} from "./terminal.protocol";

@Injectable()
export class TerminalGateway
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly sockets = new WebSocketServer({
    noServer: true,
    maxPayload: frameBytes,
    perMessageDeflate: false,
  });
  private server?: Server;
  constructor(
    private readonly adapter: HttpAdapterHost,
    private readonly auth: AuthConfig,
  ) {}

  onApplicationBootstrap() {
    this.server = this.adapter.httpAdapter.getHttpServer() as Server;
    this.server.on("upgrade", this.upgrade);
  }
  private upgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ) => {
    socket.on("error", () => socket.destroy());
    if (
      request.url !== socketPath ||
      !request.headers.origin ||
      !this.auth.trustedOrigins.has(request.headers.origin) ||
      request.headers["sec-fetch-site"] === "cross-site"
    ) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    this.sockets.handleUpgrade(request, socket, head, (client) =>
      this.connect(client),
    );
  };
  private connect(client: WebSocket) {
    let upstream: WebSocket | undefined;
    let authenticated = false;
    const timer = setTimeout(() => client.close(1008), 10000);
    const stopHeartbeat = heartbeat(client);
    client.on("error", () => client.terminate());
    client.once("close", () => {
      clearTimeout(timer);
      stopHeartbeat();
      upstream?.terminate();
    });
    client.on("message", (data, binary) => {
      if (binary) {
        client.close(1008);
        return;
      }
      if (!authenticated) {
        authenticated = true;
        clearTimeout(timer);
        let ticket: string;
        try {
          const row: unknown = JSON.parse(data.toString());
          if (
            !row ||
            typeof row !== "object" ||
            !("ticket" in row) ||
            typeof row.ticket !== "string" ||
            !/^[A-Za-z0-9_-]{43}$/.test(row.ticket) ||
            Object.keys(row).length !== 1
          )
            throw new Error();
          ticket = row.ticket;
        } catch {
          client.close(1008);
          return;
        }
        let url: URL;
        try {
          url = new URL(
            process.env.TERMINAL_RUNNER_URL ?? "ws://runner:3001/terminal",
          );
          if (
            !["ws:", "wss:"].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.search ||
            url.hash
          )
            throw new Error();
        } catch {
          client.close(1011);
          return;
        }
        upstream = new WebSocket(url, {
          headers: { Authorization: `Bearer ${ticket}` },
          maxPayload: frameBytes,
          perMessageDeflate: false,
          handshakeTimeout: 10000,
        });
        upstream.on("error", () => client.close(1011));
        upstream.once("close", () => client.close());
        upstream.on("message", (message, isBinary) => {
          if (isBinary || !sendSocket(client, message.toString()))
            client.close(1009);
        });
        return;
      }
      if (
        !upstream ||
        !sendSocket(upstream, data.toString()) ||
        upstream.bufferedAmount > bufferBytes
      )
        client.close(1009);
    });
  }
  onModuleDestroy() {
    this.server?.off("upgrade", this.upgrade);
    for (const socket of this.sockets.clients) socket.terminate();
    this.sockets.close();
  }
}
