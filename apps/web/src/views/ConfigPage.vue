<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { RouterLink, useRoute } from "vue-router";
import type {
  ConfigResponse,
  GenerationResponse,
} from "@docker-image-creator/contracts";
import { useAuthStore } from "../auth/store";
import { createConfigsClient } from "../configs/client";
const route = useRoute();
const client = createConfigsClient(useAuthStore().requestApi);
const config = ref<ConfigResponse | null>(null);
const generation = ref<GenerationResponse | null>(null);
const error = ref("");
const reconnecting = ref(false);
let abort: AbortController | undefined;
async function load() {
  abort?.abort();
  abort = new AbortController();
  const signal = abort.signal;
  error.value = "";
  try {
    config.value = await client.get(String(route.params.id), signal);
    generation.value = config.value.generation;
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
    <p v-if="generation" role="status">
      Generation: {{ generation.status }} · {{ generation.stage }}
    </p>
    <p v-if="generation && ['queued', 'running'].includes(generation.status)">
      Generation can take several minutes. This page checks its status
      automatically; you can return to it later.
    </p>
    <p v-if="reconnecting" role="status">
      Connection interrupted. Retrying the status check…
    </p>
    <p v-if="generation?.error" class="error" role="alert">
      {{ generation.error.message }}
    </p>
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
    <p><RouterLink to="/configs">Your configurations</RouterLink></p>
  </section>
</template>
