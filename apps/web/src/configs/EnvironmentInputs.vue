<script setup lang="ts">
import { ref, watch } from "vue";
import {
  ENVIRONMENT_LIMITS,
  requiredEnvironmentNames,
} from "@docker-image-creator/contracts";
import type {
  ConfigServiceInput,
  SuppliedEnvironmentValueInput,
  ServiceEnvironmentBindingInput,
} from "@docker-image-creator/contracts";

const props = defineProps<{
  services: Pick<ConfigServiceInput, "name" | "image">[];
}>();
const values = defineModel<SuppliedEnvironmentValueInput[]>("values", {
  required: true,
});
const bindings = defineModel<ServiceEnvironmentBindingInput[]>("bindings", {
  required: true,
});
const revealed = ref(new Set<object>());
watch(
  () => props.services.map((service) => service.name),
  (names, previous) => {
    if (names.length === previous.length) {
      const renamed = new Map(
        previous.map((name, index) => [name, names[index]!]),
      );
      for (const binding of bindings.value)
        binding.service = renamed.get(binding.service) ?? binding.service;
    } else {
      bindings.value = bindings.value.filter((binding) =>
        names.includes(binding.service),
      );
    }
  },
);
watch(
  () => values.value.map((value) => value.key),
  (keys, previous) => {
    if (keys.length !== previous.length) return;
    const renamed = new Map(previous.map((key, index) => [key, keys[index]!]));
    for (const binding of bindings.value)
      binding.valueKey = renamed.get(binding.valueKey) ?? binding.valueKey;
  },
);
function addValue() {
  let index = 1;
  while (values.value.some((value) => value.key === `value-${index}`)) index++;
  values.value.push({ key: `value-${index}`, value: "", purpose: "" });
}
function canAddBinding(service: string): boolean {
  return (
    bindings.value.length < ENVIRONMENT_LIMITS.bindings &&
    bindings.value.filter((binding) => binding.service === service).length <
      ENVIRONMENT_LIMITS.perService
  );
}
function removeValue(index: number) {
  const value = values.value[index]!;
  bindings.value = bindings.value.filter(
    (binding) => binding.valueKey !== value.key,
  );
  revealed.value.delete(value);
  values.value.splice(index, 1);
}
</script>

<template>
  <section aria-label="Environment values">
    <h2>Environment values</h2>
    <p class="field-help">
      Enter each value once, then assign it to one or more services. Only names,
      purposes, and assignments are sent to the model. Keep passwords out of
      purposes and instructions.
    </p>
    <div v-for="(value, index) in values" :key="index" class="service-fields">
      <label :for="`value-key-${index}`">Value key</label>
      <input
        :id="`value-key-${index}`"
        v-model="value.key"
        required
        pattern="[a-z][a-z0-9_-]{0,63}"
        maxlength="64"
        autocomplete="off"
      />
      <label :for="`value-purpose-${index}`">Purpose</label>
      <input
        :id="`value-purpose-${index}`"
        v-model="value.purpose"
        required
        maxlength="500"
        autocomplete="off"
      />
      <label :for="`value-content-${index}`">Value</label>
      <textarea
        v-if="revealed.has(value)"
        :id="`value-content-${index}`"
        v-model="value.value"
        required
        maxlength="4096"
        autocomplete="off"
        :spellcheck="false"
      />
      <input
        v-else
        :id="`value-content-${index}`"
        v-model="value.value"
        type="password"
        required
        maxlength="4096"
        autocomplete="off"
        :readonly="/[\r\n]/.test(value.value)"
      />
      <button
        type="button"
        class="secondary"
        :aria-pressed="revealed.has(value)"
        @click="
          revealed.has(value) ? revealed.delete(value) : revealed.add(value)
        "
      >
        {{ revealed.has(value) ? "Hide value" : "Show / edit multiline value" }}
      </button>
      <button type="button" class="secondary" @click="removeValue(index)">
        Remove value
      </button>
    </div>
    <button
      v-if="values.length < ENVIRONMENT_LIMITS.values"
      type="button"
      class="secondary"
      data-add-value
      @click="addValue"
    >
      Add value
    </button>
    <div
      v-for="(service, serviceIndex) in services"
      :key="serviceIndex"
      class="service-fields"
    >
      <h3>{{ service.name }} environment</h3>
      <p
        v-if="requiredEnvironmentNames(service.image).length"
        class="field-help"
      >
        Required passwords:
        {{ requiredEnvironmentNames(service.image).join(", ") }}. Default
        database/user: app.
      </p>
      <div v-for="(binding, index) in bindings" :key="index">
        <template v-if="binding.service === service.name">
          <label :for="`binding-name-${index}`">Variable name</label>
          <input
            :id="`binding-name-${index}`"
            v-model="binding.name"
            required
            pattern="[A-Za-z_][A-Za-z0-9_]{0,127}"
            maxlength="128"
          />
          <label :for="`binding-value-${index}`">Use value</label>
          <select
            :id="`binding-value-${index}`"
            v-model="binding.valueKey"
            required
          >
            <option value="" disabled>Select a value</option>
            <option v-for="value in values" :key="value.key" :value="value.key">
              {{ value.key }}
            </option>
          </select>
          <button
            type="button"
            class="secondary"
            @click="bindings.splice(index, 1)"
          >
            Remove binding
          </button>
        </template>
      </div>
      <button
        v-if="canAddBinding(service.name)"
        type="button"
        class="secondary"
        :data-add-binding="serviceIndex"
        @click="
          bindings.push({ service: service.name, name: '', valueKey: '' })
        "
      >
        Add environment variable
      </button>
    </div>
  </section>
</template>
