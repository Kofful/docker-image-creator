<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { useAuthStore } from "../auth/store";
import { authMessage } from "../auth/messages";

const props = defineProps<{ mode: "login" | "register" }>();
const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const email = ref("");
const password = ref("");
const error = ref("");
const busy = ref(false);
const heading = ref<HTMLHeadingElement | null>(null);
const registering = computed(() => props.mode === "register");
onMounted(() => heading.value?.focus());

async function submit() {
  if (busy.value) return;
  error.value = "";
  const normalizedEmail = email.value.trim().toLowerCase();
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) ||
    normalizedEmail.length > 254
  ) {
    error.value = "Enter a valid email address.";
    return;
  }
  if ([...password.value].length < 12 || [...password.value].length > 128) {
    error.value = "Password must be 12–128 characters.";
    return;
  }
  busy.value = true;
  try {
    await auth.signIn(props.mode, {
      email: normalizedEmail,
      password: password.value,
    });
    password.value = "";
    await router.replace("/account");
  } catch (cause) {
    error.value = authMessage(cause, props.mode);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="auth-card" aria-labelledby="auth-title">
    <p class="eyebrow">Your container workspace</p>
    <h1 id="auth-title" ref="heading" tabindex="-1">
      {{ registering ? "Create your account" : "Welcome back" }}
    </h1>
    <p class="intro">
      {{
        registering
          ? "Register to get your workspace ready."
          : "Log in to Docker Image Creator."
      }}
    </p>
    <p v-if="route.query.session === 'ended'" role="status" class="notice">
      Your session has ended. Please log in again.
    </p>
    <form :aria-busy="busy" novalidate @submit.prevent="submit">
      <fieldset :disabled="busy">
        <label for="email">Email address</label>
        <input
          id="email"
          v-model="email"
          type="email"
          name="email"
          autocomplete="username"
          required
          maxlength="254"
          autocapitalize="none"
          :spellcheck="false"
        />
        <label for="password">Password</label>
        <input
          id="password"
          v-model="password"
          type="password"
          name="password"
          :autocomplete="registering ? 'new-password' : 'current-password'"
          required
          aria-describedby="password-help"
        />
        <p id="password-help" class="field-help">
          Use 12–128 characters. Spaces are kept as entered.
        </p>
        <p v-if="error" role="alert" class="error">{{ error }}</p>
        <button type="submit">
          {{
            busy ? "Please wait…" : registering ? "Create account" : "Log in"
          }}
        </button>
      </fieldset>
    </form>
    <p role="status" class="field-help">
      {{ busy ? (registering ? "Creating your account…" : "Signing in…") : "" }}
    </p>
    <p v-if="!busy" class="alternate">
      {{ registering ? "Already have an account?" : "New here?" }}
      <RouterLink :to="registering ? '/login' : '/register'">{{
        registering ? "Log in" : "Create an account"
      }}</RouterLink>
    </p>
    <p class="session-note">
      For your security, refreshing or closing this page requires a new login.
    </p>
  </section>
</template>
