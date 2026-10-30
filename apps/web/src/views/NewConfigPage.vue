<script setup lang="ts">
import { ref } from "vue";
import { RouterLink, useRouter } from "vue-router";
import type {
  CatalogImage,
  ConfigServiceInput,
} from "@docker-image-creator/contracts";
import { useAuthStore } from "../auth/store";
import { AuthError } from "../auth/session";
import { createConfigsClient } from "../configs/client";
const client = createConfigsClient(useAuthStore().requestApi);
const router = useRouter();
const name = ref("");
const description = ref("");
const instructions = ref("");
const services = ref<{ name: string; image: CatalogImage }[]>([
  { name: "app", image: "node" },
]);
const busy = ref(false);
const error = ref("");
let pendingInput = "";
let pendingKey = "";
async function submit() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const input = {
      name: name.value,
      description: description.value,
      instructions: instructions.value,
      services: services.value.map(
        (service): ConfigServiceInput => ({
          ...service,
          type: ["mysql", "mongodb"].includes(service.image)
            ? "database"
            : "code",
        }),
      ),
    };
    const serialized = JSON.stringify(input);
    if (serialized !== pendingInput) {
      pendingInput = serialized;
      pendingKey = crypto.randomUUID();
    }
    const result = await client.create(input, pendingKey);
    await router.push(`/configs/${result.configId}`);
  } catch (cause) {
    error.value =
      cause instanceof AuthError && cause.status === 409
        ? "You already have an active generation or reached your configuration quota. Check your configurations."
        : "Could not confirm creation. Check your configurations before retrying; the request may have been saved.";
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section class="auth-card config-card">
    <h1>Create configuration</h1>
    <p class="notice">
      Development generator: uses catalog templates, without a live LLM.
      Containers are not started.
    </p>
    <form @submit.prevent="submit">
      <fieldset :disabled="busy">
        <label for="config-name">Name</label>
        <input id="config-name" v-model="name" required maxlength="80" />
        <label for="config-description">Description</label>
        <input id="config-description" v-model="description" maxlength="500" />
        <label for="config-instructions">
          Instructions (do not include passwords or keys)
        </label>
        <textarea
          id="config-instructions"
          v-model="instructions"
          maxlength="16000"
        />
        <p class="field-help">
          The development generator preserves selections and does not interpret
          instructions.
        </p>
        <div
          v-for="(service, index) in services"
          :key="index"
          class="service-fields"
        >
          <label :for="`service-name-${index}`">
            Service {{ index + 1 }} name
          </label>
          <input
            :id="`service-name-${index}`"
            v-model="service.name"
            required
            pattern="[a-z][a-z0-9-]{0,29}"
          />
          <label :for="`service-image-${index}`">Image</label>
          <select :id="`service-image-${index}`" v-model="service.image">
            <option value="node">Node.js starter</option>
            <option value="python">Python starter</option>
            <option value="mysql">MySQL</option>
            <option value="mongodb">MongoDB</option>
          </select>
          <button
            v-if="services.length > 1"
            type="button"
            class="secondary"
            @click="services.splice(index, 1)"
          >
            Remove service
          </button>
        </div>
        <button
          v-if="services.length < 4"
          type="button"
          class="secondary"
          @click="
            services.push({
              name: `service-${services.length + 1}`,
              image: 'python',
            })
          "
        >
          Add service
        </button>
        <button type="submit">
          {{ busy ? "Submitting…" : "Generate Compose" }}
        </button>
      </fieldset>
    </form>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <p><RouterLink to="/configs">Your configurations</RouterLink></p>
  </section>
</template>
