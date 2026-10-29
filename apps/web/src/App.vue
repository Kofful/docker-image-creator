<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { HealthResponse } from '@docker-image-creator/contracts';

const status = ref('Checking API connection…');

onMounted(async () => {
  try {
    const response = await fetch('/api/v1/health', {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error('Health request failed');
    const health: HealthResponse = await response.json();
    if (health.status !== 'ok' || health.service !== 'api') {
      throw new Error('Unexpected health response');
    }
    status.value = 'API is online';
  } catch {
    status.value = 'API is unavailable. Please try refreshing the page.';
  }
});
</script>

<template>
  <main>
    <h1>Docker Image Creator</h1>
    <p role="status">{{ status }}</p>
    <p>Account management and stack creation are coming in later milestones.</p>
  </main>
</template>

<style scoped>
main {
  max-width: 48rem;
  margin: 5rem auto;
  padding: 2rem;
  font-family: system-ui, sans-serif;
  line-height: 1.6;
  color: #183044;
}
</style>
