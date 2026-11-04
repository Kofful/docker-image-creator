<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { TerminalEndReason } from "@docker-image-creator/contracts";
import { useAuthStore } from "../auth/store";
import { AuthError } from "../auth/session";
import { createConfigsClient } from "../configs/client";
import { connectTerminal } from "../terminal/connection";

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const configId = String(route.params.id);
const service = String(route.params.service);
const title = ref("Configuration");
const status = ref("Connecting…");
const element = ref<HTMLElement>();
const abort = new AbortController();
let terminal: Terminal | undefined;
let connection: Awaited<ReturnType<typeof connectTerminal>> | undefined;
let observer: ResizeObserver | undefined;
let leaving = false;
function leave(reason: TerminalEndReason) {
  if (leaving || abort.signal.aborted) return;
  leaving = true;
  void router.replace({
    path: `/configs/${encodeURIComponent(configId)}`,
    query: { terminal: reason },
  });
}
function disconnect() {
  connection?.disconnect();
  leave("disconnected");
}
watch(
  () => auth.hasSession,
  (active) => {
    if (!active) leave("authorization_ended");
  },
);
onMounted(async () => {
  try {
    const config = await createConfigsClient(auth.requestApi).get(
      configId,
      abort.signal,
    );
    abort.signal.throwIfAborted();
    title.value = config.name;
    terminal = new Terminal({
      cursorBlink: true,
      scrollback: 2000,
      fontSize: 14,
      allowProposedApi: false,
      theme: { background: "#101923", foreground: "#e7eef4" },
    });
    // Consume clipboard writes/reads and window operations from untrusted output.
    terminal.parser.registerOscHandler(52, () => true);
    terminal.parser.registerCsiHandler({ final: "t" }, () => true);
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(element.value!);
    fit.fit();
    terminal.onData((data) => {
      // Chunk large pastes into bounded UTF-8 messages without splitting surrogate pairs.
      const chunks = data.match(/[\s\S]{1,4096}/gu) ?? [];
      for (const chunk of chunks)
        connection?.send({ type: "input", data: chunk });
    });
    terminal.onResize(({ cols, rows }) =>
      connection?.send({
        type: "resize",
        cols: Math.min(500, Math.max(2, cols)),
        rows: Math.min(300, Math.max(1, rows)),
      }),
    );
    observer = new ResizeObserver(() => {
      if (!abort.signal.aborted) fit.fit();
    });
    observer.observe(element.value!);
    connection = await connectTerminal(
      auth.requestApi,
      configId,
      service,
      {
        ready(shell) {
          status.value = `Connected · ${shell}`;
          connection?.send({
            type: "resize",
            cols: Math.min(500, terminal!.cols),
            rows: Math.min(300, terminal!.rows),
          });
          terminal?.focus();
        },
        write(data, done) {
          terminal?.write(data, done);
        },
        ended: leave,
      },
      abort.signal,
    );
  } catch (error) {
    if (!abort.signal.aborted)
      leave(
        error instanceof AuthError && error.status === 401
          ? "authorization_ended"
          : "connection_failed",
      );
  }
});
onUnmounted(() => {
  abort.abort();
  connection?.dispose();
  observer?.disconnect();
  terminal?.dispose();
});
</script>

<template>
  <section class="terminal-page" aria-labelledby="terminal-title">
    <div class="terminal-header">
      <div>
        <h1 id="terminal-title">{{ title }} · {{ service }}</h1>
        <p role="status">{{ status }}</p>
      </div>
      <button type="button" @click="disconnect">Disconnect</button>
    </div>
    <div
      ref="element"
      class="terminal-screen"
      aria-label="Interactive container terminal"
    />
    <p class="terminal-hint">
      Exit the shell or disconnect to return to the configuration. The container
      keeps running.
    </p>
  </section>
</template>

<style scoped>
.terminal-page {
  width: min(100%, 90rem);
  margin: 0 auto;
}
.terminal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}
.terminal-header h1 {
  font-size: 1.25rem;
  margin-bottom: 0.25rem;
}
.terminal-header p {
  margin-top: 0;
}
.terminal-header button {
  width: auto;
}
.terminal-screen {
  height: max(20rem, calc(100dvh - 17rem));
  background: #101923;
  padding: 0.75rem;
  border-radius: 0.5rem;
  overflow: hidden;
}
.terminal-hint {
  font-size: 0.875rem;
  color: #526575;
}
</style>
