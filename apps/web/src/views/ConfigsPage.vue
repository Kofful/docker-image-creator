<script setup lang="ts">
import { onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import type { ConfigResponse } from "@docker-image-creator/contracts";
import { useAuthStore } from "../auth/store";
import { createConfigsClient } from "../configs/client";
import DeleteConfigButton from "../configs/DeleteConfigButton.vue";
const client = createConfigsClient(useAuthStore().requestApi);
const configs = ref<ConfigResponse[]>([]);
const error = ref("");
const loading = ref(true);
const notice = ref("");
const removedIds = new Set<string>();
function removed(id: string) {
  removedIds.add(id);
  configs.value = configs.value.filter((config) => config.id !== id);
  notice.value = "Configuration removed.";
}
async function load() {
  notice.value = "";
  error.value = "";
  loading.value = true;
  try {
    configs.value = (await client.list()).filter(
      (config) => !removedIds.has(config.id),
    );
  } catch {
    error.value = "Could not load configurations. Please retry.";
  } finally {
    loading.value = false;
  }
}
onMounted(load);
</script>
<template>
  <section class="auth-card config-card">
    <h1>Your configurations</h1>
    <p>
      <RouterLink to="/configs/new">Create configuration</RouterLink> ·
      <RouterLink to="/account">Account</RouterLink>
    </p>
    <p v-if="loading" role="status">Loading configurations…</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <button type="button" class="secondary" :disabled="loading" @click="load">
      {{ error ? "Retry" : "Refresh configurations" }}
    </button>
    <p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="!loading && !error && !configs.length">No configurations yet.</p>
    <ul class="config-list">
      <li v-for="config in configs" :key="config.id">
        <RouterLink :to="`/configs/${config.id}`">{{ config.name }}</RouterLink>
        <span>— {{ config.generation.status }}</span>
        <DeleteConfigButton
          :id="config.id"
          :name="config.name"
          :generation-status="config.generation.status"
          :deletion="config.deletion"
          icon-only
          @deleted="removed(config.id)"
        />
      </li>
    </ul>
  </section>
</template>

<style scoped>
.config-list li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.25rem 0.5rem;
  margin-top: 0.75rem;
}
.config-list a {
  min-width: 0;
  overflow-wrap: anywhere;
}
</style>
