<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { api } from "@/lib/canDb";
import { createTranslator, type Locale } from "@/lib/i18n";
import type {
  ExportFormat,
  ExportGroupOption,
  ExportOptions,
} from "@/lib/export/options";
import {
  createDefaultSelection,
  normalizeSelection,
  toggleGroupFormat,
} from "@/lib/export/selection";

const props = defineProps<{
  messages: Record<string, unknown>;
  locale: Locale;
}>();
const t = createTranslator(props.messages);
const formats: ExportFormat[] = ["json", "csv", "geojson", "osm"];
const options = shallowRef<ExportOptions | null>(null);
const selected = shallowRef(new Set<string>());
const loading = ref(true);
const optionsError = ref(false);
const submitting = ref(false);
const sortedSelection = computed(() => [...selected.value].sort());
const controlsDisabled = computed(
  () => loading.value || submitting.value || !options.value,
);
const status = computed(() => {
  if (loading.value) return t("loading");
  if (optionsError.value) return t("optionsError");
  if (!selected.value.size) return t("empty");
  return t(submitting.value ? "submitting" : "selected", {
    count: selected.value.size,
  });
});
let request: AbortController | undefined;
let resetTimer: number | undefined;

async function loadOptions() {
  request?.abort();
  const controller = new AbortController();
  request = controller;
  loading.value = true;
  optionsError.value = false;
  const result = await api<ExportOptions>("/api/v1/aip/export/options", {
    signal: controller.signal,
  });
  if (controller.signal.aborted) return;
  loading.value = false;
  if (!result.ok) {
    optionsError.value = true;
    return;
  }
  options.value = result.data;
  selected.value = createDefaultSelection(result.data);
}

function selectDefaults() {
  if (options.value) selected.value = createDefaultSelection(options.value);
}

function groupPairs(group: ExportGroupOption, format: ExportFormat) {
  return group.resources
    .filter((resource) => resource.formats.includes(format))
    .map((resource) => `${resource.id}.${format}`);
}

function groupChecked(group: ExportGroupOption, format: ExportFormat) {
  const pairs = groupPairs(group, format);
  return pairs.length > 0 && pairs.every((pair) => selected.value.has(pair));
}

function groupMixed(group: ExportGroupOption, format: ExportFormat) {
  return (
    !groupChecked(group, format) &&
    groupPairs(group, format).some((pair) => selected.value.has(pair))
  );
}

function toggleGroup(
  group: ExportGroupOption,
  format: ExportFormat,
  event: Event,
) {
  if (!options.value) return;
  selected.value = toggleGroupFormat(
    options.value,
    selected.value,
    group.id,
    format,
    (event.target as HTMLInputElement).checked,
  );
}

function togglePair(resource: string, format: ExportFormat, event: Event) {
  if (!options.value) return;
  const next = new Set(selected.value);
  const pair = `${resource}.${format}`;
  if ((event.target as HTMLInputElement).checked) next.add(pair);
  else next.delete(pair);
  selected.value = normalizeSelection(options.value, next);
}

function resetSubmitting() {
  if (resetTimer !== undefined) window.clearTimeout(resetTimer);
  resetTimer = undefined;
  submitting.value = false;
}

function onSubmit(event: Event) {
  if (controlsDisabled.value || !selected.value.size) {
    event.preventDefault();
    return;
  }
  submitting.value = true;
  resetTimer = window.setTimeout(resetSubmitting, 1500);
}

onMounted(() => {
  window.addEventListener("pageshow", resetSubmitting);
  void loadOptions();
});

onBeforeUnmount(() => {
  request?.abort();
  resetSubmitting();
  window.removeEventListener("pageshow", resetSubmitting);
});
</script>

<template>
  <form
    action="/api/v1/aip/export"
    method="get"
    class="space-y-6"
    @submit="onSubmit"
  >
    <input
      v-for="include in sortedSelection"
      :key="include"
      type="hidden"
      name="include"
      :value="include"
    />
    <input type="hidden" name="locale" :value="locale" />

    <div class="flex flex-wrap items-center gap-3">
      <button
        type="button"
        class="btn btn-secondary"
        :disabled="controlsDisabled"
        @click="selectDefaults"
      >
        {{ t("selectAll") }}
      </button>
      <button
        type="button"
        class="btn btn-secondary"
        :disabled="controlsDisabled || !selected.size"
        @click="selected = new Set()"
      >
        {{ t("clear") }}
      </button>
    </div>

    <p id="export-unsupported" class="text-sm text-muted">
      {{ t("unsupported") }}
    </p>
    <p
      role="status"
      aria-live="polite"
      aria-atomic="true"
      class="text-sm text-muted"
    >
      {{ status }}
    </p>
    <button
      v-if="optionsError"
      type="button"
      class="btn btn-secondary"
      :disabled="loading"
      @click="loadOptions"
    >
      {{ t("retry") }}
    </button>

    <fieldset
      v-for="group in options?.groups ?? []"
      :key="group.id"
      class="card min-w-0 p-4"
      :disabled="controlsDisabled"
    >
      <legend class="text-title-3 px-2 text-ink">
        {{ t(`groups.${group.id}`) }}
      </legend>
      <div class="scroll-shadow-x overflow-x-auto">
        <table class="data-table w-full text-sm">
          <thead>
            <tr>
              <th scope="col">{{ t("resource") }}</th>
              <th v-for="format in formats" :key="format" scope="col">
                <label
                  :for="`export-group-${group.id}-${format}`"
                  class="flex items-center gap-2 whitespace-nowrap"
                >
                  <input
                    :id="`export-group-${group.id}-${format}`"
                    type="checkbox"
                    :checked="groupChecked(group, format)"
                    :indeterminate="groupMixed(group, format)"
                    :disabled="!groupPairs(group, format).length"
                    :aria-describedby="
                      !groupPairs(group, format).length
                        ? 'export-unsupported'
                        : undefined
                    "
                    @change="toggleGroup(group, format, $event)"
                  />
                  <span aria-hidden="true">{{ t(`formats.${format}`) }}</span>
                  <span class="sr-only">{{
                    t("selectGroupFormat", {
                      group: t(`groups.${group.id}`),
                      format: t(`formats.${format}`),
                    })
                  }}</span>
                </label>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="resource in group.resources" :key="resource.id">
              <th scope="row" class="text-left font-medium">
                {{ t(`resources.${resource.id}`) }}
              </th>
              <td v-for="format in formats" :key="format">
                <label
                  :for="`export-${resource.id}-${format}`"
                  class="flex min-h-8 items-center gap-2"
                >
                  <input
                    :id="`export-${resource.id}-${format}`"
                    type="checkbox"
                    :checked="selected.has(`${resource.id}.${format}`)"
                    :disabled="!resource.formats.includes(format)"
                    :aria-describedby="
                      !resource.formats.includes(format)
                        ? 'export-unsupported'
                        : undefined
                    "
                    @change="togglePair(resource.id, format, $event)"
                  />
                  <span class="sr-only"
                    >{{ t(`resources.${resource.id}`) }} —
                    {{ t(`formats.${format}`) }}</span
                  >
                  <span
                    v-if="!resource.formats.includes(format)"
                    aria-hidden="true"
                    class="text-faint"
                    >—</span
                  >
                </label>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </fieldset>

    <button
      type="submit"
      class="btn btn-primary"
      :disabled="controlsDisabled || !selected.size"
    >
      {{ t(submitting ? "submitting" : "download", { count: selected.size }) }}
    </button>
  </form>
</template>
