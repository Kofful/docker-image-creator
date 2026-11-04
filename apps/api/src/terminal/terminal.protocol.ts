import type { TerminalClientMessage } from "@docker-image-creator/contracts";
import { WebSocket } from "ws";

// Transport memory bounds, not session duration or connection-count quotas.
export const frameBytes = 64 * 1024;
export const bufferBytes = 1024 * 1024;
export const socketPath = "/api/v1/terminal";

export function parseClientMessage(text: string): TerminalClientMessage {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid message");
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort().join(",");
  if (row.type === "disconnect" && keys === "type")
    return { type: "disconnect" };
  if (
    row.type === "input" &&
    keys === "data,type" &&
    typeof row.data === "string" &&
    Buffer.byteLength(row.data) <= frameBytes / 2
  )
    return { type: "input", data: row.data };
  if (
    row.type === "resize" &&
    keys === "cols,rows,type" &&
    Number.isInteger(row.cols) &&
    Number.isInteger(row.rows) &&
    Number(row.cols) >= 2 &&
    Number(row.cols) <= 500 &&
    Number(row.rows) >= 1 &&
    Number(row.rows) <= 300
  )
    return { type: "resize", cols: Number(row.cols), rows: Number(row.rows) };
  throw new Error("Invalid message");
}

export function sendSocket(socket: WebSocket, text: string): boolean {
  if (
    socket.readyState !== WebSocket.OPEN ||
    socket.bufferedAmount + Buffer.byteLength(text) > bufferBytes
  )
    return false;
  socket.send(text, (error) => {
    if (error) socket.terminate();
  });
  return true;
}

// Protocol liveness only. An idle, healthy terminal has no timeout.
export function heartbeat(socket: WebSocket): () => void {
  let alive = true;
  const pong = () => {
    alive = true;
  };
  socket.on("pong", pong);
  const timer = setInterval(() => {
    if (!alive) socket.terminate();
    else if (socket.readyState === WebSocket.OPEN) {
      alive = false;
      socket.ping();
    }
  }, 15000);
  timer.unref();
  const dispose = () => {
    clearInterval(timer);
    socket.off("pong", pong);
  };
  socket.once("close", dispose);
  return dispose;
}
