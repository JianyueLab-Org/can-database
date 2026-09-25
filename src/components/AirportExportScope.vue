<script setup lang="ts">
/**
 * 导出页的第一步：机场范围。
 *
 * 选中的机场排成一行可逐个移除的筛子，下面是可搜索的清单（限高、自己滚动 —— 两百多个
 * 机场平铺开来，第二步要往下翻一整屏才看得到）。一个都不选就是「全部当前机场」，这句
 * 话一直写在状态行里，不让「没选」看起来像「选了零个」。
 *
 * **这里不 import 任何 `.vue`**，搜索框也是手写的而没有用 `SearchField.vue`：
 * `src/lib/export/page.test.ts` 只把这个文件和 `DatasetExport.vue` 编译成模块，多 import
 * 一个 SFC 那份测试就加载不起来。样式照 `SearchField` 抄，行为（Enter 不提交表单）由测
 * 试钉着。
 */
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
  listFailed: boolean;
  invalidBlank: boolean;
}>();
const emit = defineEmits<{
  "update:selected": [selected: Set<string>];
  retry: [];
  clear: [];
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

const selectedList = computed(() => [...props.selected].sort());

/** 搜索词筛出来、还没选上的那几个 —— 「全选筛出的」只加不减。 */
const addable = computed(() =>
  query.value.trim()
    ? shown.value.filter((airport) => !props.selected.has(airport.icao))
    : [],
);

function toggle(icao: string, event: Event) {
  const next = new Set(props.selected);
  if ((event.target as HTMLInputElement).checked) next.add(icao);
  else next.delete(icao);
  emit("update:selected", next);
}

function remove(icao: string) {
  const next = new Set(props.selected);
  next.delete(icao);
  emit("update:selected", next);
}

function addShown() {
  const next = new Set(props.selected);
  for (const airport of addable.value) next.add(airport.icao);
  emit("update:selected", next);
}

function onSearchKeydown(event: KeyboardEvent) {
  // Esc 先清空，空了再失焦 —— 和 SearchField 一样。
  if (event.key === "Escape" && query.value) {
    event.preventDefault();
    query.value = "";
  }
}
</script>

<template>
  <fieldset class="card min-w-0 space-y-3 p-4">
    <legend class="text-title-3 px-2 text-ink">{{ t("airportScope") }}</legend>
    <p class="text-sm text-muted">{{ t("airportScopeHint") }}</p>

    <div class="flex flex-wrap items-center gap-2">
      <p
        id="export-airport-status"
        role="status"
        aria-live="polite"
        class="tnum mr-auto text-sm text-ink"
      >
        {{
          selected.size
            ? t("airportsSelected", { count: selected.size })
            : t("allAirports")
        }}
      </p>
      <button
        type="button"
        class="btn btn-ghost h-8 px-2.5 text-xs"
        :disabled="!selected.size && !invalidBlank"
        @click="emit('clear')"
      >
        {{ t("clearAirports") }}
      </button>
    </div>

    <ul
      v-if="selectedList.length"
      class="flex flex-wrap gap-1.5"
      :aria-label="t('airportScope')"
    >
      <li v-for="icao in selectedList" :key="icao">
        <span
          class="chip border-strong pr-1 font-mono"
          :class="unresolved.includes(icao) ? 'text-danger' : 'text-ink'"
        >
          {{ icao }}
          <button
            type="button"
            class="icon-button size-5 text-faint hover:text-ink"
            :aria-label="t('removeAirport', { icao })"
            @click="remove(icao)"
          >
            <svg
              viewBox="0 0 20 20"
              fill="currentColor"
              class="size-3.5"
              aria-hidden="true"
            >
              <path
                d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z"
              />
            </svg>
          </button>
        </span>
      </li>
    </ul>

    <div
      v-if="scopeError"
      role="alert"
      class="flex flex-wrap items-center gap-3 rounded-card bg-danger-bg px-4 py-3 text-sm text-danger-fg"
    >
      <p v-if="listFailed && !selected.size" class="min-w-0 flex-1">
        {{ t("airportListError") }}
      </p>
      <p v-else-if="invalidBlank" class="min-w-0 flex-1">
        {{ t("airportScopeInvalid") }}
      </p>
      <p v-else class="min-w-0 flex-1">
        {{ t("airportScopeError", { airports: unresolved.join(", ") }) }}
      </p>
      <button
        type="button"
        class="btn btn-secondary h-8 px-2.5 text-xs"
        :disabled="loading"
        @click="emit('retry')"
      >
        {{ t("retryAirports") }}
      </button>
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <div class="relative min-w-52 flex-1">
        <label class="sr-only" for="export-airport-search">{{
          t("airportSearch")
        }}</label>
        <svg
          viewBox="0 0 20 20"
          fill="currentColor"
          class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint"
          aria-hidden="true"
        >
          <path
            fill-rule="evenodd"
            d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.45 4.39l3.08 3.08a.75.75 0 1 1-1.06 1.06l-3.08-3.08A7 7 0 0 1 2 9Z"
            clip-rule="evenodd"
          />
        </svg>
        <input
          id="export-airport-search"
          v-model="query"
          type="search"
          class="input w-full pl-9"
          autocomplete="off"
          spellcheck="false"
          :placeholder="t('airportSearch')"
          @keydown.enter.prevent
          @keydown="onSearchKeydown"
        />
      </div>
      <button
        v-if="addable.length"
        type="button"
        class="btn btn-secondary h-9 px-3 text-xs"
        @click="addShown"
      >
        {{ t("addShownAirports", { count: addable.length }) }}
      </button>
    </div>

    <p v-if="!shown.length" class="py-4 text-center text-sm text-muted">
      {{ t("airportNoResults") }}
    </p>
    <template v-else>
      <ul
        class="scroll-shadow-y grid max-h-72 gap-x-3 overflow-y-auto rounded-control border border-subtle p-1.5 sm:grid-cols-2 lg:grid-cols-3"
      >
        <li v-for="airport in shown" :key="airport.icao">
          <label
            :for="`export-airport-${airport.icao}`"
            class="flex min-h-8 cursor-pointer items-center gap-2 rounded-control px-2 hover:bg-surface-sunken"
          >
            <input
              :id="`export-airport-${airport.icao}`"
              type="checkbox"
              :checked="selected.has(airport.icao)"
              @change="toggle(airport.icao, $event)"
            />
            <span class="font-mono text-ink">{{ airport.icao }}</span>
            <span class="min-w-0 flex-1 truncate text-sm text-muted">{{
              airport.name
            }}</span>
            <span v-if="airport.fir" class="font-mono text-xs text-faint">{{
              airport.fir
            }}</span>
          </label>
        </li>
      </ul>
      <p class="tnum text-xs text-faint">
        {{
          t("airportsShown", { shown: shown.length, total: airports.length })
        }}
      </p>
    </template>
  </fieldset>
</template>
