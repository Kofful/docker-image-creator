<script setup lang="ts">
import { computed, ref } from "vue";
import type { GenerationResponse } from "@docker-image-creator/contracts";
import { useAuthStore } from "../auth/store";
import { AuthError } from "../auth/session";
import { createConfigsClient } from "./client";

const props = defineProps<{
  id: string;
  name: string;
  generationStatus: GenerationResponse["status"];
  iconOnly?: boolean;
  disabledReason?: string;
}>();
const emit = defineEmits<{ deleted: []; deleting: [value: boolean] }>();
const client = createConfigsClient(useAuthStore().requestApi);
const deleting = ref(false);
const error = ref("");
const generating = computed(() =>
  ["queued", "running"].includes(props.generationStatus),
);

async function remove() {
  if (deleting.value || generating.value || props.disabledReason) return;
  if (
    !window.confirm(
      `Delete "${props.name}"? This removes the saved configuration and its local Compose files. You cannot restore it from the app.`,
    )
  )
    return;
  deleting.value = true;
  emit("deleting", true);
  error.value = "";
  try {
    await client.remove(props.id);
    emit("deleted");
  } catch (cause) {
    if (cause instanceof AuthError && cause.status === 404) {
      // A different tab or an earlier request may already have deleted it.
      emit("deleted");
    } else if (cause instanceof AuthError && cause.status === 403) {
      error.value =
        "Generation is still in progress. Try deleting again after it finishes.";
    } else if (cause instanceof AuthError && cause.status === 409) {
      error.value =
        "This configuration has a deployment. Deletion requires runtime cleanup, which is not available yet, even after Stop.";
    } else {
      error.value = "Could not confirm deletion. Please retry.";
    }
  } finally {
    deleting.value = false;
    emit("deleting", false);
  }
}
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
