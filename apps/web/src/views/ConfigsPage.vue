<script setup lang="ts">
import { onMounted, ref } from "vue";
import { RouterLink } from "vue-router";
import type { ConfigResponse } from "@docker-image-creator/contracts";
import { useAuthStore } from "../auth/store";
import { createConfigsClient } from "../configs/client";
const client = createConfigsClient(useAuthStore().requestApi);
const configs = ref<ConfigResponse[]>([]);
const error = ref("");
const loading = ref(true);
async function load() {
  error.value = "";
  loading.value = true;
  try {
    configs.value = await client.list();
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
    <button v-if="error" type="button" @click="load">Retry</button>
    <p v-if="!loading && !error && !configs.length">No configurations yet.</p>
    <ul>
      <li v-for="config in configs" :key="config.id">
        <RouterLink :to="`/configs/${config.id}`">{{ config.name }}</RouterLink>
        — {{ config.generation.status }}
      </li>
    </ul>
  </section>
</template>
