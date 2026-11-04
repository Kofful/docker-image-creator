<script setup lang="ts">
import { watch } from "vue";
import { RouterLink, RouterView, useRouter } from "vue-router";
import { useAuthStore } from "./auth/store";

const auth = useAuthStore();
const router = useRouter();
watch(
  () => auth.hasSession,
  (active) => {
    if (
      !active &&
      router.currentRoute.value.meta.requiresAuth &&
      !router.currentRoute.value.meta.terminal &&
      !(
        router.currentRoute.value.meta.terminalLanding &&
        router.currentRoute.value.query.terminal === "authorization_ended"
      )
    ) {
      void router.replace({ path: "/login", query: { session: "ended" } });
    }
  },
);
</script>

<template>
  <div class="app-shell">
    <header class="site-header">
      <RouterLink class="brand" to="/">Docker Image Creator</RouterLink>
      <span class="milestone">Local workspace</span>
    </header>
    <main id="main-content">
      <RouterView :key="$route.path" />
    </main>
  </div>
</template>
