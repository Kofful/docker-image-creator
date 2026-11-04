import type {
  TerminalClientMessage,
  TerminalEndReason,
  TerminalServerMessage,
  TerminalTicketResponse,
} from "@docker-image-creator/contracts";

interface TerminalView {
  write(data: string, done: () => void): void;
  ready(shell: string): void;
  ended(reason: TerminalEndReason): void;
}

// One connection per explicit page entry. Never reconnect automatically.
export async function connectTerminal(
  requestApi: (path: string, init?: RequestInit) => Promise<Response>,
  configId: string,
  service: string,
  view: TerminalView,
  signal: AbortSignal,
) {
  const response = await requestApi(
    `/api/v1/configs/${encodeURIComponent(configId)}/services/${encodeURIComponent(service)}/terminal-tickets`,
    { method: "POST", signal },
  );
  signal.throwIfAborted();
  const ticket = (await response.json()) as TerminalTicketResponse;
  if (
    ticket.socketPath !== "/api/v1/terminal" ||
    !/^[A-Za-z0-9_-]{43}$/.test(ticket.ticket)
  )
    throw new Error("Invalid terminal ticket");
  signal.throwIfAborted();
  const url = new URL(ticket.socketPath, window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(url);
  let ended = false;
  let ready = false;
  let pendingBytes = 0;
  const timer = setTimeout(() => end("connection_failed"), 15000);
  const end = (reason: TerminalEndReason) => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    if (socket.readyState === WebSocket.OPEN) socket.close();
    else if (socket.readyState === WebSocket.CONNECTING)
      socket.addEventListener("open", () => socket.close(), { once: true });
    if (!signal.aborted) view.ended(reason);
  };
  socket.onopen = () => {
    if (ended || signal.aborted) {
      socket.close();
      return;
    }
    // Ticket is a first message, never a URL/subprotocol or a reusable access token.
    socket.send(JSON.stringify({ ticket: ticket.ticket }));
  };
  socket.onerror = () => end(ready ? "connection_lost" : "connection_failed");
  socket.onclose = () => end(ready ? "connection_lost" : "connection_failed");
  socket.onmessage = (event: MessageEvent<unknown>) => {
    if (ended || signal.aborted) return;
    try {
      if (typeof event.data !== "string" || event.data.length > 65536)
        throw new Error();
      const message = JSON.parse(event.data) as TerminalServerMessage;
      if (message.type === "ready" && typeof message.shell === "string") {
        ready = true;
        clearTimeout(timer);
        view.ready(message.shell);
      } else if (
        message.type === "output" &&
        typeof message.data === "string" &&
        ready
      ) {
        pendingBytes += message.data.length;
        if (pendingBytes > 1024 * 1024) {
          end("output_overflow");
          return;
        }
        view.write(message.data, () => {
          pendingBytes -= message.data.length;
        });
      } else if (message.type === "exit") end(message.reason);
      else throw new Error();
    } catch {
      end("connection_failed");
    }
  };
  const abort = () => end("disconnected");
  signal.addEventListener("abort", abort, { once: true });
  return {
    send(message: TerminalClientMessage) {
      if (ended || !ready || socket.readyState !== WebSocket.OPEN) return;
      if (socket.bufferedAmount > 1024 * 1024) {
        end("connection_lost");
        return;
      }
      socket.send(JSON.stringify(message));
    },
    disconnect() {
      if (socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify({ type: "disconnect" }));
      end("disconnected");
    },
    dispose() {
      signal.removeEventListener("abort", abort);
      end("disconnected");
    },
  };
}
