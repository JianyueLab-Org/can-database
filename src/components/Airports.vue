<script setup lang="ts">
/**
 * 机场清单：一个搜索框 + FIR 筛子 + 区域码 + 一张可排序的表。
 *
 * ## 筛选和翻页在 can-db
 *
 * 全库约 1.5 万个机场，不整份下发。搜索词、FIR、区域码都是 `/aip/airports` 的参数，
 * 每页 `AIRPORT_PAGE` 条，按 ICAO 排；响应头 `X-Next-Cursor` 在还有下一页时给游标，
 * 「载入更多」接着取。第一页随页面服务端渲染下来，用的是同一份地址栏参数。
 *
 * 搜索是 can-db 的**前缀**匹配（ICAO 或名称开头），敲字防抖 250 ms。
 *
 * 搜索词、FIR、区域码和排序都挂在地址栏上（`?q=`、`?fir=`、`?region=`、`?sort=`）。
 * 搜索框里回车、只剩一个机场时直接打开它。
 *
 * ## 排序只排已载入的行
 *
 * can-db 只按 ICAO 排。其他列的排序是渲染，作用于已载入的那几页；还有下一页时表下写明。
 *
 * ## 表，不是卡片
 *
 * 这一页是拿来校对的：「哪几个场没有机位」「哪个场标高是空的」是一列一列看出来的，卡片
 * 网格把同一个字段摆在三列不同的位置上，扫不下去。
 *
 * ## FIR 的颜色和地图是同一套
 *
 * 色块取自 `@/lib/mapBase` 的 `firColor`，和 /map 上那张图逐字同源。
 */
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from "vue";
import { AlertBox, EmptyState, Icon, Spinner } from "@jianyuelab-org/can-ui";
import { createTranslator } from "@/lib/i18n";
import { firColor } from "@/lib/mapBase";
import { api, type AirportSummary, type Licence } from "@/lib/canDb";
import { AIRPORT_PAGE, REGION_PATTERN, airportsQuery } from "@/lib/viewport";
import { useQueryState } from "@/composables/useQueryState";
import ExportButton from "@/components/ExportButton.vue";
import SearchField from "@/components/ui/SearchField.vue";
import FilterChips from "@/components/ui/FilterChips.vue";
import ListToolbar from "@/components/lists/ListToolbar.vue";

const props = defineProps<{
  messages: Record<string, unknown>;
  /** 第一页，服务端按 `initialFilters` 取好。 */
  airports: AirportSummary[];
  nextCursor: string | null;
  /** 全库机场数（`/aip/overview`）；取不到是 null。 */
  total: number | null;
  firs: string[];
  initialFilters: { q: string; fir: string; region: string };
  licence: Licence | null;
  exportMessages: Record<string, unknown>;
}>();
const t = createTranslator(props.messages);

const query = useQueryState("q");
/** '' = 不限 FIR。 */
const activeFir = useQueryState("fir");
/** '' = 不限区域码。格式不对的值不发给 can-db。 */
const region = useQueryState("region");
/** 排序键，前缀 `-` 表示降序。 */
const sort = useQueryState("sort", "icao");

const rows = shallowRef<AirportSummary[]>(props.airports);
const cursor = ref<string | null>(props.nextCursor);
const loading = ref(false);
const loadingMore = ref(false);
const error = ref("");

const normalizedRegion = computed(() => {
  const r = region.value.trim().toUpperCase();
  return REGION_PATTERN.test(r) ? r : "";
});

function filtersKey(q: string, fir: string, reg: string) {
  return JSON.stringify([q.trim(), fir, reg]);
}
const currentKey = computed(() =>
  filtersKey(query.value, activeFir.value, normalizedRegion.value),
);
/** 当前 `rows` 对应的筛选。服务端第一页就是 initialFilters 那一组。 */
let loadedKey = filtersKey(
  props.initialFilters.q,
  props.initialFilters.fir,
  props.initialFilters.region,
);
/** 最近一次请求的序号 —— 先发后到的那份不能盖掉后发的。 */
let latest = 0;
let debounce: ReturnType<typeof setTimeout> | undefined;

function filterParams() {
  return {
    q: query.value,
    fir: activeFir.value,
    region: normalizedRegion.value,
    limit: AIRPORT_PAGE,
  };
}

async function reload() {
  const key = currentKey.value;
  if (key === loadedKey) return;
  const seq = ++latest;
  loading.value = true;
  error.value = "";
  const result = await api<AirportSummary[]>(
    `/api/v1/aip/airports?${airportsQuery(filterParams())}`,
  );
  if (seq !== latest) return;
  loading.value = false;
  if (!result.ok) {
    error.value = result.message;
    return;
  }
  loadedKey = key;
  rows.value = result.data ?? [];
  cursor.value = result.nextCursor;
}

async function loadMore() {
  if (!cursor.value || loadingMore.value) return;
  const seq = latest;
  loadingMore.value = true;
  const result = await api<AirportSummary[]>(
    `/api/v1/aip/airports?${airportsQuery({ ...filterParams(), cursor: cursor.value })}`,
  );
  loadingMore.value = false;
  // 这期间换过筛选，这一页属于旧的那一组。
  if (seq !== latest) return;
  if (!result.ok) {
    error.value = result.message;
    return;
  }
  rows.value = [...rows.value, ...(result.data ?? [])];
  cursor.value = result.nextCursor;
}

watch(currentKey, () => {
  if (debounce !== undefined) clearTimeout(debounce);
  debounce = setTimeout(() => void reload(), 250);
});

onMounted(() => {
  // 地址栏里不认识的 FIR 清掉 —— 和服务端「不认识就当没传」是同一条。
  if (activeFir.value && !props.firs.includes(activeFir.value)) {
    activeFir.value = "";
  }
});
onBeforeUnmount(() => {
  if (debounce !== undefined) clearTimeout(debounce);
});

type SortKey = "icao" | "fir" | "elev" | "stands";
const SORT_KEYS: SortKey[] = ["icao", "fir", "elev", "stands"];
/** 数字列第一次点下去先降序 —— 要找的通常是「机位最多的」「标高最高的」。 */
const NUMERIC: SortKey[] = ["elev", "stands"];

const sortState = computed(() => {
  const raw = sort.value;
  const desc = raw.startsWith("-");
  const key = (desc ? raw.slice(1) : raw) as SortKey;
  return SORT_KEYS.includes(key)
    ? { key, desc }
    : { key: "icao" as SortKey, desc: false };
});

function sortBy(key: SortKey) {
  const { key: current, desc } = sortState.value;
  const nextDesc = current === key ? !desc : NUMERIC.includes(key);
  sort.value = `${nextDesc ? "-" : ""}${key}`;
}

function ariaSort(key: SortKey) {
  const s = sortState.value;
  if (s.key !== key) return "none";
  return s.desc ? "descending" : "ascending";
}

const firChips = computed(() =>
  props.firs.map((fir) => ({
    value: fir,
    label: fir,
    color: firColor(fir),
    mono: true,
  })),
);

/** 空值（没有标高）不论升降都排在最后 —— 它们是要单独去看的那一批，不该夹在中间。 */
const shown = computed(() => {
  const { key, desc } = sortState.value;
  const dir = desc ? -1 : 1;
  return [...rows.value].sort((a, b) => {
    let cmp = 0;
    if (key === "elev" || key === "stands") {
      const x = a[key];
      const y = b[key];
      if (x === null && y === null) cmp = 0;
      else if (x === null) return 1;
      else if (y === null) return -1;
      else cmp = (x - y) * dir;
    } else if (key === "fir") {
      cmp = (a.fir ?? "").localeCompare(b.fir ?? "") * dir;
    }
    return cmp || a.icao.localeCompare(b.icao) * (key === "icao" ? dir : 1);
  });
});

const filtering = computed(
  () => !!query.value.trim() || !!activeFir.value || !!region.value,
);
/** 其他列的排序只排了已载入的行，而后面还有。 */
const partialSort = computed(
  () => !!cursor.value && sortState.value.key !== "icao",
);

function clearFilters() {
  query.value = "";
  activeFir.value = "";
  region.value = "";
}

/** 回车：只剩一个就直接打开。 */
function openSingle() {
  if (rows.value.length === 1 && !cursor.value) {
    window.location.href = `/airports/${rows.value[0].icao}`;
  }
}

const mapHref = computed(() =>
  activeFir.value ? `/map?fir=${encodeURIComponent(activeFir.value)}` : "/map",
);

const columns: { key: SortKey | null; label: string; align?: "right" }[] = [
  { key: "icao", label: t("icao") },
  { key: null, label: t("name") },
  { key: "fir", label: t("fir") },
  { key: null, label: t("coords") },
  { key: "elev", label: t("elevFt"), align: "right" },
  { key: "stands", label: t("standsTitle"), align: "right" },
];

function sortIcon(key: SortKey) {
  const s = sortState.value;
  if (s.key !== key) return "chevronUpDown";
  return s.desc ? "chevronDown" : "chevronUp";
}

/**
 * 整行可点。键盘和中键仍走 ICAO 那个真链接；这里只接住点在行里别处的那一下。
 * 选中文字（拖选坐标）不算点击。
 */
function openRow(event: MouseEvent, icao: string) {
  if ((event.target as HTMLElement).closest("a, button")) return;
  if (window.getSelection()?.toString()) return;
  const href = `/airports/${icao}`;
  if (event.metaKey || event.ctrlKey) window.open(href, "_blank");
  else window.location.assign(href);
}
</script>

<template>
  <div>
    <ListToolbar>
      <template #search>
        <SearchField
          v-model="query"
          :label="t('searchLabel')"
          :placeholder="t('search')"
          @submit="openSingle"
        />
      </template>
      <template #actions>
        <a :href="mapHref" class="link text-sm whitespace-nowrap"
          >{{ t("onMap") }} →</a
        >
        <!-- 导出跟随筛选，不跟随排序：排序是这一屏怎么看，不是数据。还有下一页时这里只有
             一部分，不给按钮，指向导出页。 -->
        <ExportButton
          v-if="!cursor"
          resource="airports"
          :scope="activeFir || null"
          :rows="rows"
          :licence="licence"
          :messages="exportMessages"
        />
        <a v-else href="/export" class="link text-sm whitespace-nowrap">{{
          t("exportAll")
        }}</a>
      </template>
      <template #filters>
        <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
          <FilterChips
            v-model="activeFir"
            :chips="firChips"
            :label="t('firFilter')"
            :all-label="t('allFirs')"
            :all-count="total ?? undefined"
          />
          <label class="flex items-center gap-2 text-xs text-muted">
            {{ t("regionFilter") }}
            <input
              v-model="region"
              type="text"
              class="input h-8 w-16 font-mono text-xs uppercase"
              maxlength="2"
              autocomplete="off"
              spellcheck="false"
              :placeholder="t('regionHint')"
              :aria-invalid="!!region && !normalizedRegion"
            />
          </label>
        </div>
      </template>
      <template #count>
        <span>{{
          cursor
            ? t("loadedCount", { n: String(rows.length) })
            : filtering || total === null
              ? t("matchedCount", { n: String(rows.length) })
              : t("shownCount", {
                  n: String(rows.length),
                  total: String(total),
                })
        }}</span>
        <Spinner v-if="loading" size="sm" />
      </template>
    </ListToolbar>

    <AlertBox v-if="error" variant="danger" class="mb-4">{{ error }}</AlertBox>

    <div v-if="!rows.length && !filtering" class="card">
      <EmptyState :title="t('noData')" icon="buildingOffice" compact />
    </div>

    <div v-else-if="!shown.length" class="card">
      <EmptyState :title="t('empty')" icon="magnifyingGlass" compact>
        <template v-if="filtering" #action>
          <button type="button" class="btn btn-secondary" @click="clearFilters">
            {{ t("clearFilters") }}
          </button>
        </template>
      </EmptyState>
    </div>

    <div v-else class="scroll-shadow-x overflow-x-auto">
      <table class="data-table w-full text-sm">
        <thead>
          <tr>
            <th
              v-for="c in columns"
              :key="c.label"
              :aria-sort="c.key ? ariaSort(c.key) : undefined"
              :class="{ 'text-right': c.align === 'right' }"
            >
              <button
                v-if="c.key"
                type="button"
                class="inline-flex items-center gap-1 rounded-sm hover:text-ink focus-visible:shadow-[var(--ring-brand)] focus-visible:outline-none"
                :class="{
                  'text-ink': sortState.key === c.key,
                  'flex-row-reverse': c.align === 'right',
                }"
                @click="sortBy(c.key)"
              >
                {{ c.label }}
                <Icon
                  :name="sortIcon(c.key)"
                  class="size-3.5"
                  :class="sortState.key === c.key ? 'text-can' : 'text-faint'"
                />
              </button>
              <template v-else>{{ c.label }}</template>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="a in shown"
            :key="a.icao"
            class="row-link"
            @click="openRow($event, a.icao)"
          >
            <td :data-label="t('icao')">
              <a
                :href="`/airports/${a.icao}`"
                class="row-link__target font-mono font-semibold text-ink"
                >{{ a.icao }}</a
              >
            </td>
            <td
              :data-label="t('name')"
              class="text-muted sm:max-w-72 sm:truncate"
            >
              {{ a.name ?? "—" }}
            </td>
            <td :data-label="t('fir')">
              <span class="inline-flex items-center gap-1.5">
                <span
                  class="inline-block size-2 shrink-0 rounded-full"
                  :style="{ backgroundColor: firColor(a.fir) }"
                  aria-hidden="true"
                />
                <span class="font-mono text-xs">{{ a.fir ?? "—" }}</span>
              </span>
            </td>
            <td
              :data-label="t('coords')"
              class="tnum text-xs whitespace-nowrap text-faint"
            >
              {{ a.lat.toFixed(3) }}, {{ a.lon.toFixed(3) }}
            </td>
            <td :data-label="t('elevFt')" class="tnum text-right">
              <span v-if="a.elev !== null">{{ a.elev }}</span>
              <span v-else class="text-faint">—</span>
            </td>
            <!-- 机位数本来就在这条响应里（can-db 的 AirportIndex 带着它）。它是「这个场
                 的数据全不全」最直接的一眼，所以 0 印成淡色的 0，不印成空。 -->
            <td
              :data-label="t('standsTitle')"
              class="tnum text-right"
              :class="{ 'text-faint': !a.stands }"
            >
              {{ a.stands }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 还有下一页要说出来：一个悄悄截断的列表会让人以为剩下的不存在。 -->
    <div
      v-if="cursor && shown.length"
      class="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2"
    >
      <button
        type="button"
        class="btn btn-secondary"
        :disabled="loadingMore"
        @click="loadMore"
      >
        {{ loadingMore ? t("loadingMore") : t("loadMore") }}
      </button>
      <p class="text-xs text-faint">
        {{ partialSort ? t("partialSort") : t("moreHint") }}
      </p>
    </div>
  </div>
</template>
