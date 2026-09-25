<script setup lang="ts">
/**
 * 导出页：机场范围 → 资源和格式 → 核对并下载。
 *
 * 表单是原生的 GET（`/api/v1/aip/export`），下载由浏览器自己接，这里只管拼出 `include`
 * / `airport` / `locale` 三组字段。选择规则（默认全选 JSON、按组勾格式、不支持的组合剔掉）
 * 在 `src/lib/export/selection.ts`，这里不重写。
 *
 * **DOM 形状有测试钉着**（`src/lib/export/page.test.ts`）：`fieldset` 只有范围和各资源
 * 组那几个、矩阵表格只有资源组那几张、`form > p[role=status]` 是唯一的播报区。所以步
 * 骤标题是普通的 `h2`，右边的核对卡片不是 `fieldset` 也不是表格，而播报区挂在 `form`
 * 下面、视觉上隐藏 —— 屏幕上看得见的那一份在核对卡片里。同一个原因，这里和
 * `AirportExportScope.vue` 不 import 任何别的 `.vue`（包括 can-ui 的组件）：测试只编
 * 译这两个 SFC。样式用 can-ui 的类。
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from "vue";
import { api } from "@/lib/canDb";
import type { AirportSummary } from "@/lib/canDb";
import { createTranslator, type Locale } from "@/lib/i18n";
import AirportExportScope from "@/components/AirportExportScope.vue";
import type {
  ExportFormat,
  ExportGroupOption,
  ExportOptions,
} from "@/lib/export/options";
import {
  createDefaultSelection,
  normalizeAirportCodes,
  normalizeSelection,
  parseAirportScope,
  toggleGroupFormat,
} from "@/lib/export/selection";

const props = defineProps<{
  messages: Record<string, unknown>;
  locale: Locale;
  airports: AirportSummary[];
  airportListFailed: boolean;
}>();
const t = createTranslator(props.messages);
const formats: ExportFormat[] = ["json", "csv", "geojson", "osm"];
const options = shallowRef<ExportOptions | null>(null);
const selected = shallowRef(new Set<string>());
const selectedAirports = shallowRef(new Set<string>());
const airportOptions = shallowRef(props.airports);
const airportListFailed = ref(props.airportListFailed);
const airportLoading = ref(false);
const invalidAirportScope = ref(false);
const loading = ref(true);
const optionsError = ref(false);
const submitting = ref(false);
const sortedSelection = computed(() => [...selected.value].sort());
const unresolvedAirports = computed(() => {
  const available = new Set(
    airportOptions.value.map((airport) => airport.icao),
  );
  return normalizeAirportCodes(selectedAirports.value).filter(
    (airport) => !available.has(airport),
  );
});
const airportScopeBlocked = computed(
  () =>
    airportListFailed.value ||
    invalidAirportScope.value ||
    (selectedAirports.value.size > 0 && unresolvedAirports.value.length > 0),
);
const controlsDisabled = computed(
  () =>
    loading.value ||
    submitting.value ||
    !options.value ||
    airportScopeBlocked.value,
);
const status = computed(() => {
  if (loading.value) return t("loading");
  if (optionsError.value) return t("optionsError");
  if (!selected.value.size) return t("empty");
  return t(submitting.value ? "submitting" : "selected", {
    count: selected.value.size,
  });
});

/** 核对卡片：选了哪些资源、各格式几项、多少项受机场范围限制。 */
const summary = computed(() => {
  const byFormat = new Map<ExportFormat, number>();
  const resources = new Set<string>();
  for (const pair of selected.value) {
    const dot = pair.lastIndexOf(".");
    const format = pair.slice(dot + 1) as ExportFormat;
    resources.add(pair.slice(0, dot));
    byFormat.set(format, (byFormat.get(format) ?? 0) + 1);
  }
  const scoped = (options.value?.groups ?? [])
    .flatMap((group) => group.resources)
    .filter(
      (resource) => resource.airportScoped && resources.has(resource.id),
    ).length;
  return {
    resources: resources.size,
    scoped,
    formats: formats
      .filter((format) => byFormat.has(format))
      .map((format) => ({ format, count: byFormat.get(format)! })),
  };
});

const AIRPORT_PREVIEW = 6;
const airportPreview = computed(() => {
  const list = normalizeAirportCodes(selectedAirports.value);
  return {
    shown: list.slice(0, AIRPORT_PREVIEW),
    more: Math.max(0, list.length - AIRPORT_PREVIEW),
  };
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

function clearAirportScope() {
  selectedAirports.value = new Set();
  invalidAirportScope.value = false;
}

async function loadAirports() {
  airportLoading.value = true;
  const result = await api<AirportSummary[]>("/api/v1/aip/airports");
  airportLoading.value = false;
  if (!result.ok) {
    airportListFailed.value = true;
    return;
  }
  airportOptions.value = result.data ?? [];
  airportListFailed.value = false;
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
  const requestedAirports = new URL(window.location.href).searchParams.getAll(
    "airport",
  );
  const airportScope = parseAirportScope(requestedAirports);
  invalidAirportScope.value = airportScope.hasInvalidBlank;
  selectedAirports.value = new Set(airportScope.airports);
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
    class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_19rem] lg:items-start"
    @submit="onSubmit"
  >
    <input
      v-for="include in sortedSelection"
      :key="include"
      type="hidden"
      name="include"
      :value="include"
    />
    <input
      v-for="airport in normalizeAirportCodes(selectedAirports)"
      :key="airport"
      type="hidden"
      name="airport"
      :value="airport"
    />
    <input type="hidden" name="locale" :value="locale" />

    <div class="min-w-0 space-y-8">
      <section class="space-y-3">
        <h2 class="flex items-center gap-2.5 text-sm font-semibold text-ink">
          <span
            class="tnum flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-xs text-muted"
            aria-hidden="true"
            >1</span
          >
          {{ t("stepScope") }}
        </h2>
        <AirportExportScope
          :airports="airportOptions"
          :selected="selectedAirports"
          :messages="messages"
          :scope-error="airportScopeBlocked"
          :unresolved="unresolvedAirports"
          :loading="airportLoading"
          :list-failed="airportListFailed"
          :invalid-blank="invalidAirportScope"
          @update:selected="selectedAirports = $event"
          @retry="loadAirports"
          @clear="clearAirportScope"
        />
        <p class="text-sm text-muted">{{ t("globalResources") }}</p>
      </section>

      <section class="space-y-3">
        <div class="flex flex-wrap items-center gap-2">
          <h2
            class="mr-auto flex items-center gap-2.5 text-sm font-semibold text-ink"
          >
            <span
              class="tnum flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-xs text-muted"
              aria-hidden="true"
              >2</span
            >
            {{ t("stepResources") }}
          </h2>
          <button
            type="button"
            class="btn btn-secondary h-8 px-2.5 text-xs"
            :disabled="controlsDisabled"
            @click="selectDefaults"
          >
            {{ t("selectAll") }}
          </button>
          <button
            type="button"
            class="btn btn-ghost h-8 px-2.5 text-xs"
            :disabled="controlsDisabled || !selected.size"
            @click="selected = new Set()"
          >
            {{ t("clear") }}
          </button>
        </div>

        <p id="export-unsupported" class="text-xs text-faint">
          {{ t("unsupported") }}
        </p>
        <p id="export-scroll-hint" class="text-xs text-faint">
          {{ t("scrollHint") }}
        </p>

        <div v-if="loading" class="card space-y-3 p-4" aria-hidden="true">
          <div class="skeleton h-5 w-40"></div>
          <div v-for="n in 4" :key="n" class="skeleton h-8 w-full"></div>
        </div>
        <div
          v-else-if="optionsError"
          class="flex flex-wrap items-center gap-3 rounded-card bg-danger-bg px-4 py-3 text-sm text-danger-fg"
        >
          <p class="min-w-0 flex-1">{{ t("optionsError") }}</p>
          <button
            type="button"
            class="btn btn-secondary h-8 px-2.5 text-xs"
            :disabled="loading"
            @click="loadOptions"
          >
            {{ t("retry") }}
          </button>
        </div>

        <fieldset
          v-for="group in options?.groups ?? []"
          :key="group.id"
          class="card min-w-0 p-4"
          :disabled="controlsDisabled"
        >
          <legend
            :id="`export-group-${group.id}`"
            class="text-title-3 px-2 text-ink"
          >
            {{ t(`groups.${group.id}`) }}
          </legend>
          <div
            role="region"
            tabindex="0"
            :aria-labelledby="`export-group-${group.id}`"
            aria-describedby="export-scroll-hint"
            class="scroll-shadow-x overflow-x-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-can"
          >
            <table
              class="export-matrix w-full min-w-[40rem] border-collapse text-left text-sm [&_td]:px-3 [&_td]:py-2 [&_th]:px-3 [&_th]:py-2 [&_tbody_tr]:border-t [&_tbody_tr]:border-subtle"
            >
              <thead>
                <tr class="text-xs text-muted">
                  <th scope="col" class="font-medium">{{ t("resource") }}</th>
                  <th
                    v-for="format in formats"
                    :key="format"
                    scope="col"
                    class="font-medium"
                  >
                    <label
                      :for="`export-group-${group.id}-${format}`"
                      class="flex cursor-pointer items-center gap-2 whitespace-nowrap"
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
                      <span aria-hidden="true">{{
                        t(`formats.${format}`)
                      }}</span>
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
                <tr
                  v-for="resource in group.resources"
                  :key="resource.id"
                  class="hover:bg-surface-sunken"
                >
                  <th scope="row" class="text-left font-medium text-ink">
                    <span :id="`export-resource-${resource.id}`">
                      {{ t(`resources.${resource.id}`) }}
                      <span
                        v-if="resource.airportScoped"
                        class="badge badge-neutral ml-2"
                      >
                        {{ t("airportScoped") }}
                      </span>
                    </span>
                  </th>
                  <td v-for="format in formats" :key="format">
                    <label
                      :for="`export-${resource.id}-${format}`"
                      class="flex min-h-8 cursor-pointer items-center gap-2"
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
      </section>
    </div>

    <!-- 第三步：核对并下载。桌面上钉在右栏，往下翻矩阵的时候一直看得见选了多少。 -->
    <aside
      class="card space-y-4 p-4 lg:sticky lg:top-6"
      :aria-labelledby="'export-review-title'"
    >
      <h2
        id="export-review-title"
        class="flex items-center gap-2.5 text-sm font-semibold text-ink"
      >
        <span
          class="tnum flex size-6 shrink-0 items-center justify-center rounded-full bg-surface-sunken text-xs text-muted"
          aria-hidden="true"
          >3</span
        >
        {{ t("stepReview") }}
      </h2>

      <dl class="space-y-3 text-sm">
        <div>
          <dt class="text-eyebrow text-faint">{{ t("summaryScope") }}</dt>
          <dd class="mt-1">
            <span v-if="!airportPreview.shown.length" class="text-ink">{{
              t("allAirports")
            }}</span>
            <span v-else class="flex flex-wrap gap-1">
              <span
                v-for="icao in airportPreview.shown"
                :key="icao"
                class="badge badge-neutral font-mono"
                >{{ icao }}</span
              >
              <span
                v-if="airportPreview.more"
                class="tnum text-xs text-faint"
                >{{
                  t("summaryMoreAirports", { count: airportPreview.more })
                }}</span
              >
            </span>
          </dd>
        </div>
        <div>
          <dt class="text-eyebrow text-faint">{{ t("summaryResources") }}</dt>
          <dd class="mt-1">
            <p v-if="loading" class="skeleton h-5 w-32"></p>
            <p v-else-if="!selected.size" class="text-muted">
              {{ t("empty") }}
            </p>
            <template v-else>
              <p class="tnum text-ink">
                {{
                  t("summaryCounts", {
                    resources: summary.resources,
                    pairs: selected.size,
                  })
                }}
              </p>
              <p class="mt-1.5 flex flex-wrap gap-1">
                <span
                  v-for="item in summary.formats"
                  :key="item.format"
                  class="badge badge-neutral tnum"
                  >{{ t(`formats.${item.format}`) }} · {{ item.count }}</span
                >
              </p>
              <p
                v-if="summary.scoped && airportPreview.shown.length"
                class="tnum mt-1.5 text-xs text-faint"
              >
                {{ t("summaryScoped", { count: summary.scoped }) }}
              </p>
            </template>
          </dd>
        </div>
      </dl>

      <div
        class="rounded-control bg-surface-sunken px-3 py-2.5 text-xs text-muted"
      >
        <p class="font-semibold text-ink">{{ t("licenceTitle") }}</p>
        <p class="mt-1">{{ t("licenceNote") }}</p>
      </div>

      <button
        type="submit"
        class="btn btn-primary w-full"
        :disabled="controlsDisabled || !selected.size"
      >
        {{
          t(submitting ? "submitting" : "download", { count: selected.size })
        }}
      </button>
    </aside>

    <!-- 唯一的播报区。看得见的那一份在上面的核对卡片里，这里只念给读屏听。 -->
    <p role="status" aria-live="polite" aria-atomic="true" class="sr-only">
      {{ status }}
    </p>
  </form>
</template>
