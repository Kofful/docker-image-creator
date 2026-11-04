import type { TerminalEndReason } from "@docker-image-creator/contracts";

export const terminalMessages: Record<TerminalEndReason, string> = {
  disconnected: "Terminal disconnected. The container is still running.",
  shell_exited: "The container shell exited.",
  connection_lost:
    "Terminal connection lost. Use Connect to open a new session.",
  authorization_ended:
    "Your terminal session ended because authentication expired or was revoked. Log in to connect again.",
  container_unavailable:
    "The container is stopped or unavailable. Check its status before connecting again.",
  shell_unavailable:
    "This container has neither Bash nor sh available for a terminal.",
  output_overflow:
    "The terminal connection could not keep up with its output. Use Connect to open a new session.",
  connection_failed:
    "Could not establish the terminal connection. Check the container status and try Connect again.",
};
export function terminalNotice(reason: unknown): string {
  return typeof reason === "string" && Object.hasOwn(terminalMessages, reason)
    ? terminalMessages[reason as TerminalEndReason]
    : "";
}
