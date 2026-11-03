<script setup lang="ts">
import { computed } from "vue";
import type {
  ConfigServiceInput,
  ConfigServicesResponse,
  ContainerState,
  ServiceRuntimeResponse,
} from "@docker-image-creator/contracts";

const props = defineProps<{
  configuredServices: ConfigServiceInput[];
  snapshot: ConfigServicesResponse | null;
  error: string;
  loading: boolean;
  pending: boolean;
}>();
defineEmits<{ retry: [] }>();
const rows = computed<ServiceRuntimeResponse[]>(
  () =>
    props.snapshot?.services ??
    props.configuredServices.map((service) => ({
      name: service.name,
      image: service.image,
      state: "unknown",
      health: null,
      publishedPort: null,
      observedAt: null,
    })),
);
const labels: Record<ContainerState, string> = {
  not_created: "Not created",
  created: "Created",
  running: "Running",
  restarting: "Restarting",
  paused: "Paused",
  exited: "Exited",
  dead: "Dead",
  removing: "Removing",
  unknown: "Unknown",
};
const healthLabels = {
  starting: "Starting",
  healthy: "Healthy",
  unhealthy: "Unhealthy",
};
const unknown = computed(() =>
  rows.value.some((row) => row.state === "unknown"),
);
function portLabel(port: NonNullable<ServiceRuntimeResponse["publishedPort"]>) {
  return `${port.host}:${port.hostPort} → ${port.containerPort}/tcp`;
}
</script>

<template>
  <section
    class="containers"
    aria-labelledby="containers-title"
    :aria-busy="loading || pending"
  >
    <h2 id="containers-title">Containers</h2>
    <p v-if="loading" role="status">Loading container status…</p>
    <p v-else-if="pending" role="status">
      Updating container status… Previous observations are shown until
      refreshed.
    </p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <button v-if="error" type="button" @click="$emit('retry')">
      Retry container status check
    </button>
    <p v-else-if="unknown && !loading && !pending" class="notice">
      Container status is unavailable for one or more services.
    </p>
    <p v-if="!rows.length && !loading">No services configured.</p>
    <div
      v-if="rows.length"
      class="container-table-scroll"
      tabindex="0"
      role="region"
      aria-label="Container status table"
    >
      <table>
        <caption class="observation-note">
          Latest available observations; updated on page entry and Start/Stop.
        </caption>
        <thead>
          <tr>
            <th scope="col">Service</th>
            <th scope="col">Image</th>
            <th scope="col">State</th>
            <th scope="col">Health</th>
            <th scope="col">Published port</th>
            <th scope="col">Last observed</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.name" :data-service="row.name">
            <th scope="row">{{ row.name }}</th>
            <td>
              <code>{{ row.image }}</code>
            </td>
            <td>
              <div class="container-state" :data-state="row.state">
                {{ labels[row.state] }}
              </div>
              <span v-if="error && row.observedAt" class="stale">Stale</span>
            </td>
            <td :data-health="row.health">
              {{ row.health ? healthLabels[row.health] : "—" }}
            </td>
            <td v-if="row.publishedPort">
              <code>{{ portLabel(row.publishedPort) }}</code>
            </td>
            <td v-else>{{ row.state === "unknown" ? "Unknown" : "—" }}</td>
            <td>
              <time v-if="row.observedAt" :datetime="row.observedAt">{{
                new Date(row.observedAt).toLocaleString()
              }}</time
              ><span v-else>Not observed</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.containers {
  margin: 1.5rem 0;
}
.container-table-scroll {
  overflow-x: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
  text-align: left;
  font-size: 0.875rem;
}
th,
td {
  padding: 0.7rem;
  border-bottom: 1px solid #dce5eb;
  vertical-align: top;
}
thead th {
  color: #526575;
}
code {
  white-space: nowrap;
}
.observation-note {
  text-align: left;
  color: #526575;
  padding-bottom: 0.75rem;
}
.container-state {
  font-weight: 650;
}
.container-state[data-state="running"] {
  color: #22623c;
}
.container-state[data-state="unknown"],
[data-health="unhealthy"],
.stale {
  color: #972f35;
}
.container-state[data-state="restarting"],
[data-health="starting"] {
  color: #785619;
}
</style>
