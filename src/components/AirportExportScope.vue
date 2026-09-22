<script setup lang="ts">
import { computed, ref } from "vue";
import { createTranslator } from "@/lib/i18n";
import type { AirportSummary } from "@/lib/canDb";

const props = defineProps<{
  airports: AirportSummary[];
  selected: ReadonlySet<string>;
  messages: Record<string, unknown>;
  scopeError: boolean;
  unresolved: string[];
  loading: boolean;
}>();
const emit = defineEmits<{
  "update:selected": [selected: Set<string>];
  retry: [];
}>();
const t = createTranslator(props.messages);
const query = ref("");

const shown = computed(() => {
  const needle = query.value.trim().toUpperCase();
  return [...props.airports]
    .sort((left, right) => left.icao.localeCompare(right.icao))
    .filter(
      (airport) =>
        !needle ||
        airport.icao.includes(needle) ||
        (airport.name ?? "").toUpperCase().includes(needle) ||
        (airport.fir ?? "").includes(needle),
    );
});

function toggle(icao: string, event: Event) {
  const next = new Set(props.selected);
  if ((event.target as HTMLInputElement).checked) next.add(icao);
  else next.delete(icao);
  emit("update:selected", next);
}
</script>

<template>
  <fieldset class="card space-y-3 p-4">
    <legend class="text-title-3 px-2 text-ink">{{ t("airportScope") }}</legend>
    <p class="text-sm text-muted">{{ t("airportScopeHint") }}</p>
    <div class="flex flex-wrap items-end gap-3">
      <div class="min-w-52 flex-1">
        <label
          class="mb-1 block text-xs text-muted"
          for="export-airport-search"
          >{{ t("airportSearch") }}</label
        >
        <input
          id="export-airport-search"
          v-model="query"
          type="search"
          class="input w-full"
          autocomplete="off"
          :placeholder="t('airportSearch')"
          @keydown.enter.prevent
        />
      </div>
      <button
        type="button"
        class="btn btn-secondary"
        :disabled="!selected.size"
        @click="emit('update:selected', new Set())"
      >
        {{ t("clearAirports") }}
      </button>
    </div>
    <p
      id="export-airport-status"
      role="status"
      aria-live="polite"
      class="text-sm text-muted"
    >
      {{
        selected.size
          ? t("airportsSelected", { count: selected.size })
          : t("allAirports")
      }}
    </p>
    <div v-if="scopeError" role="alert" class="space-y-2 text-sm text-danger">
      <p>{{ t("airportScopeError", { airports: unresolved.join(", ") }) }}</p>
      <button
        type="button"
        class="btn btn-secondary"
        :disabled="loading"
        @click="emit('retry')"
      >
        {{ t("retryAirports") }}
      </button>
    </div>
    <p v-if="!shown.length" class="text-sm text-muted">
      {{ t("airportNoResults") }}
    </p>
    <ul v-else class="grid gap-1 sm:grid-cols-2">
      <li v-for="airport in shown" :key="airport.icao">
        <label
          :for="`export-airport-${airport.icao}`"
          class="flex min-h-8 items-center gap-2"
        >
          <input
            :id="`export-airport-${airport.icao}`"
            type="checkbox"
            :checked="selected.has(airport.icao)"
            @change="toggle(airport.icao, $event)"
          />
          <span class="font-mono text-ink">{{ airport.icao }}</span>
          <span class="text-sm text-muted">{{ airport.name }}</span>
          <span v-if="airport.fir" class="text-xs text-faint">{{
            airport.fir
          }}</span>
        </label>
      </li>
    </ul>
  </fieldset>
</template>
