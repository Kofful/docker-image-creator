<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useAuthStore } from "../auth/store";
import { authMessage } from "../auth/messages";

const auth = useAuthStore();
const router = useRouter();
const checking = ref(true);
const verified = ref(false);
const leaving = ref(false);
const error = ref("");
const heading = ref<HTMLHeadingElement | null>(null);

async function checkAccount() {
  checking.value = true;
  error.value = "";
  try {
    await auth.loadUser();
    verified.value = true;
  } catch (cause) {
    verified.value = false;
    error.value = authMessage(cause, "account");
  } finally {
    checking.value = false;
  }
}

async function logout() {
  if (leaving.value) return;
  leaving.value = true;
  error.value = "";
  try {
    await auth.signOut();
    await router.replace("/login");
  } catch (cause) {
    error.value = authMessage(cause, "logout");
  } finally {
    leaving.value = false;
  }
}

onMounted(() => {
  heading.value?.focus();
  void checkAccount();
});
</script>

<template>
  <section
    class="auth-card"
    aria-labelledby="account-title"
    :aria-busy="checking || leaving"
  >
    <p class="eyebrow">Your account</p>
    <h1 id="account-title" ref="heading" tabindex="-1">Workspace ready</h1>
    <p v-if="checking" role="status">Checking your account…</p>
    <template v-else-if="verified">
      <p class="intro">
        Signed in as <strong>{{ auth.user?.email }}</strong>
      </p>
    </template>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <button
      v-if="!checking && !verified"
      type="button"
      :disabled="leaving"
      @click="checkAccount"
    >
      Retry account check
    </button>
    <button
      class="secondary"
      type="button"
      :disabled="checking || leaving"
      @click="logout"
    >
      {{ leaving ? "Logging out…" : "Log out" }}
    </button>
  </section>
</template>
