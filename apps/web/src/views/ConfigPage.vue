<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import type {
  ConfigResponse,
  GenerationResponse,
} from "@docker-image-creator/contracts";
import { useAuthStore } from "../auth/store";
import { createConfigsClient } from "../configs/client";
import DeleteConfigButton from "../configs/DeleteConfigButton.vue";
import { useConfigRuntime } from "../configs/useConfigRuntime";
const route = useRoute();
const router = useRouter();
const client = createConfigsClient(useAuthStore().requestApi);
const {
  state,
  operation,
  checked,
  pendingAction,
  canAct,
  statusError,
  actionError,
  deleteDisabledReason,
  refresh: refreshRuntime,
  submit,
} = useConfigRuntime(String(route.params.id), useAuthStore().requestApi);
const config = ref<ConfigResponse | null>(null);
const generation = ref<GenerationResponse | null>(null);
const error = ref("");
const reconnecting = ref(false);
const deleting = ref(false);
const labels = {
  not_started: "Not started",
  starting: "Starting",
  running: "Running",
  stopping: "Stopping",
  stopped: "Stopped",
  failed: "Failed",
  unknown: "Unknown",
};
const generating = computed(() =>
  ["queued", "running"].includes(generation.value?.status ?? ""),
);
const action = computed(() =>
  ["running", "failed", "unknown"].includes(state.value) && checked.value
    ? "stop"
    : "start",
);
const actionLabel = computed(() => {
  if (state.value === "starting") return "Starting…";
  if (state.value === "stopping") return "Stopping…";
  return action.value === "stop" ? "Stop" : "Start";
});
const actionDisabled = computed(
  () =>
    !canAct.value ||
    deleting.value ||
    generating.value ||
    ["starting", "stopping"].includes(state.value) ||
    (action.value === "start" && !config.value?.revision),
);
function runAction() {
  if (actionDisabled.value) return;
  void submit(
    action.value,
    action.value === "start" ? config.value?.revision?.id : undefined,
  );
}
let abort: AbortController | undefined;
async function removed() {
  abort?.abort();
  await router.replace("/configs");
}
async function load() {
  abort?.abort();
  abort = new AbortController();
  const signal = abort.signal;
  error.value = "";
  try {
    config.value = await client.get(String(route.params.id), signal);
    signal.throwIfAborted();
    generation.value = config.value.generation;
    refreshRuntime();
    if (["queued", "running"].includes(generation.value.status)) {
      const result = await client.poll(generation.value.id, {
        signal,
        onStatus: (value) => {
          generation.value = value;
        },
        onConnectionChange: (value) => {
          reconnecting.value = value;
        },
      });
      if (result.status === "succeeded")
        config.value = await client.get(result.configId, signal);
    }
  } catch {
    if (!signal.aborted)
      error.value =
        "Could not load this configuration. You can retry without starting another generation.";
  }
}
onMounted(load);
onUnmounted(() => abort?.abort());
</script>
<template>
  <section class="auth-card config-card">
    <h1>{{ config?.name ?? "Configuration" }}</h1>
    <p v-if="config?.description">{{ config.description }}</p>
    <p v-if="config" role="status">
      <span class="runtime-status" :data-state="state">{{
        labels[state]
      }}</span>
    </p>
    <p v-if="generating" role="status">
      Generating Compose: {{ generation?.stage }}. Generation can take several
      minutes. This page checks its status automatically; you can return to it
      later.
    </p>
    <p v-if="reconnecting" role="status">
      Connection interrupted. Retrying the status check…
    </p>
    <p v-if="generation?.error" class="error" role="alert">
      {{ generation.error.message }}
    </p>
    <p v-if="operation?.error" class="error" role="alert">
      {{ operation.error.message }}
    </p>
    <p v-if="operation?.cleanupPending" class="notice">
      Some resources may still be running. Use Stop to confirm they are stopped;
      persistent data is preserved.
    </p>
    <p
      v-if="operation && ['queued', 'running'].includes(operation.status)"
      role="status"
    >
      Runtime operation: {{ operation.status }} · {{ operation.stage }}
    </p>
    <p v-if="statusError" class="error" role="alert">{{ statusError }}</p>
    <button v-if="statusError" type="button" @click="refreshRuntime">
      Retry runtime status check
    </button>
    <p v-if="actionError" class="error" role="alert">{{ actionError }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <button v-if="error" type="button" @click="load">Retry status check</button>
    <template v-if="config?.revision">
      <p class="notice">
        Compose saved. Generated with the development provider; Docker runtime
        validation has not been performed. Database secrets will be supplied
        privately by the runner.
      </p>
      <pre tabindex="0" aria-label="Saved Compose configuration">{{
        config.revision.compose
      }}</pre>
    </template>
    <div v-if="config && generation" class="config-actions">
      <button
        type="button"
        :disabled="actionDisabled"
        :aria-busy="!!pendingAction || ['starting', 'stopping'].includes(state)"
        @click="runAction"
      >
        {{ actionLabel }}
      </button>
      <DeleteConfigButton
        :id="config.id"
        :key="config.id"
        :name="config.name"
        :generation-status="generation.status"
        :disabled-reason="deleteDisabledReason"
        @deleting="deleting = $event"
        @deleted="removed"
      />
    </div>
    <p><RouterLink to="/configs">Your configurations</RouterLink></p>
  </section>
</template>

<style scoped>
.config-actions {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
}
.config-actions > button {
  width: auto;
  flex-shrink: 0;
}
.runtime-status {
  display: inline-block;
  border-radius: 1rem;
  padding: 0.15rem 0.7rem;
  background: #edf3f6;
  color: #183044;
  font-size: 0.875rem;
  font-weight: 650;
}
.runtime-status[data-state="running"] {
  background: #e5f4eb;
  color: #22623c;
}
.runtime-status[data-state="starting"],
.runtime-status[data-state="stopping"] {
  background: #fff3d9;
  color: #785619;
}
.runtime-status[data-state="failed"],
.runtime-status[data-state="unknown"] {
  background: #fff0f0;
  color: #972f35;
}
</style>
