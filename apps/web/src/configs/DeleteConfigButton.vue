<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from "vue";
import type {
  GenerationResponse,
  RuntimeOperationResponse,
} from "@docker-image-creator/contracts";
import { useAuthStore } from "../auth/store";
import { AuthError } from "../auth/session";
import { createConfigsClient } from "./client";
import { createRuntimeClient } from "./runtime-client";

const props = defineProps<{
  id: string;
  name: string;
  generationStatus: GenerationResponse["status"];
  deletion?: RuntimeOperationResponse | null;
  iconOnly?: boolean;
  disabledReason?: string;
}>();
const emit = defineEmits<{
  deleted: [];
  deleting: [value: boolean];
  operation: [value: RuntimeOperationResponse];
}>();
const request = useAuthStore().requestApi;
const client = createConfigsClient(request);
const runtime = createRuntimeClient(request);
const deleting = ref(false);
const error = ref("");
const statusUnavailable = ref(false);
const generating = computed(() =>
  ["queued", "running"].includes(props.generationStatus),
);
let key: string | undefined;
let operationId: string | undefined;
let abort: AbortController | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;
let failures = 0;
let disposed = false;

function busy(value: boolean) {
  deleting.value = value;
  emit("deleting", value);
}
async function check(signal: AbortSignal) {
  try {
    const operation = await runtime.operation(operationId!, signal);
    signal.throwIfAborted();
    if (
      operation.id !== operationId ||
      operation.configId !== props.id ||
      operation.type !== "delete"
    )
      throw new Error("Deletion status does not match the request");
    failures = 0;
    error.value = "";
    statusUnavailable.value = false;
    emit("operation", operation);
    if (operation.status === "succeeded") {
      busy(false);
      emit("deleted");
      return;
    }
    if (operation.status === "failed") {
      key = undefined;
      busy(false);
      error.value = `Cleanup failed. ${operation.error?.message ?? "Retry Delete to finish cleanup. Persistent data is preserved."}`;
      return;
    }
  } catch (cause) {
    if (signal.aborted) return;
    error.value =
      "Could not check deletion status. The configuration remains visible until cleanup is confirmed.";
    if (
      cause instanceof AuthError &&
      cause.status > 0 &&
      cause.status < 500 &&
      cause.status !== 429
    ) {
      statusUnavailable.value = true;
      return;
    }
    failures += 1;
  }
  if (!signal.aborted)
    timer = setTimeout(
      () => void check(signal),
      Math.min(30000, 2000 * 2 ** Math.min(failures, 4)),
    );
}
function follow(id: string) {
  clearTimeout(timer);
  abort?.abort();
  operationId = id;
  abort = new AbortController();
  busy(true);
  void check(abort.signal);
}
watch(
  () => props.deletion,
  (operation) => {
    if (
      !operation ||
      operation.type !== "delete" ||
      operation.configId !== props.id ||
      disposed
    )
      return;
    if (
      ["queued", "running"].includes(operation.status) &&
      operationId !== operation.id
    )
      follow(operation.id);
    else if (operation.status === "failed" && !deleting.value)
      error.value = `Cleanup failed. ${operation.error?.message ?? "Retry Delete to finish cleanup. Persistent data is preserved."}`;
  },
  { immediate: true },
);

async function remove() {
  if (deleting.value || generating.value || props.disabledReason) return;
  if (
    !window.confirm(
      `Delete "${props.name}"? This removes the saved configuration, stopped containers, network, and local Compose files. Persistent database data is preserved. You cannot restore the configuration from the app.`,
    )
  )
    return;
  busy(true);
  error.value = "";
  key ??= crypto.randomUUID();
  abort = new AbortController();
  const signal = abort.signal;
  try {
    const result = await client.remove(props.id, key, signal);
    signal.throwIfAborted();
    if (result) follow(result.operationId);
    else {
      busy(false);
      emit("deleted");
    }
  } catch (cause) {
    if (signal.aborted || disposed) return;
    deleting.value = false;
    const uncertain =
      !(cause instanceof AuthError) ||
      cause.status === 0 ||
      cause.status >= 500;
    emit("deleting", uncertain);
    if (cause instanceof AuthError && cause.status === 404) emit("deleted");
    else if (cause instanceof AuthError && cause.status === 403)
      error.value =
        "Generation is still in progress. Try deleting again after it finishes.";
    else if (cause instanceof AuthError && cause.status === 409)
      error.value =
        "Stop the configuration and wait for pending operations to finish before deleting it.";
    else error.value = "Could not confirm deletion. Please retry.";
  }
}
onScopeDispose(() => {
  disposed = true;
  clearTimeout(timer);
  abort?.abort();
});
</script>

<template>
  <div class="config-delete" :class="{ compact: iconOnly }">
    <button
      type="button"
      class="danger"
      :aria-label="`Delete ${name}`"
      :aria-busy="deleting"
      :title="deleting ? 'Deleting…' : `Delete ${name}`"
      :disabled="deleting || generating || !!disabledReason"
      @click="remove"
    >
      <svg
        v-if="iconOnly"
        width="16"
        height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        aria-hidden="true"
      >
        <path d="M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6" />
      </svg>
      <template v-else>{{ deleting ? "Deleting…" : "Delete" }}</template>
    </button>
    <p v-if="disabledReason" class="field-help">{{ disabledReason }}</p>
    <p v-else-if="generating" class="field-help">
      Deletion is available after generation finishes.
    </p>
    <p v-if="deleting" role="status">
      Deleting… Waiting for cleanup confirmation. Persistent data is preserved.
    </p>
    <button
      v-if="statusUnavailable"
      type="button"
      @click="follow(operationId!)"
    >
      Retry deletion status check
    </button>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.config-delete button {
  width: auto;
}
.danger {
  background: #972f35;
}
.danger:hover {
  background: #76252a;
}
.compact {
  display: contents;
}
.compact button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  min-height: 2rem;
  height: 2rem;
  padding: 0;
  margin: 0;
  flex-shrink: 0;
  background: transparent;
  color: #972f35;
}
.compact button:hover {
  background: #fff0f0;
}
.compact p {
  flex-basis: 100%;
  order: 1;
  margin: 0.25rem 0;
}
</style>
