<script setup lang="ts">
/**
 * 机场清单：一个即时过滤框 + 一排 FIR 筛选 + 一张可排序的表。
 *
 * 岛屿而不是服务端渲染，因为这一页唯一的操作就是「找那个机场」，而 233 行里翻找不如
 * 敲四个字母。清单整份随页面下来（每条六个字段，比图标精灵图还小），所以过滤是本地
 * 的 —— 每敲一个键往返一次服务器是这一页最容易犯的错。
 *
 * 搜索词、FIR 和排序都挂在地址栏上（`?q=`、`?fir=`、`?sort=`），刷新、后退、把链接
 * 发给别人都还在原处。搜索框里回车、只剩一个机场时直接打开它。
 *
 * ## 表，不是卡片
 *
 * 这一页是拿来校对的：「哪几个场没有机位」「哪个场标高是空的」是一列一列看出来的，卡片
 * 网格把同一个字段摆在三列不同的位置上，扫不下去。排序只是渲染，留在这里。
 *
 * ## FIR 的颜色和地图是同一套
 *
 * 色块取自 `@/lib/mapBase` 的 `firColor`，和 /map 上那张图逐字同源。一个成员在清单上
 * 认得的 ZGZU 的颜色，点进地图应该还是那一个 —— 两处各写一份配色，漂移只是时间问题。
 */
import { computed } from "vue";
import { EmptyState, Icon } from "@jianyuelab-org/can-ui";
import { createTranslator } from "@/lib/i18n";
import { firColor } from "@/lib/mapBase";
import type { AirportSummary, Licence } from "@/lib/canDb";
import { useQueryState } from "@/composables/useQueryState";
import ExportButton from "@/components/ExportButton.vue";
import SearchField from "@/components/ui/SearchField.vue";
import FilterChips from "@/components/ui/FilterChips.vue";
import ListToolbar from "@/components/lists/ListToolbar.vue";

const props = defineProps<{
  messages: Record<string, unknown>;
  airports: AirportSummary[];
  licence: Licence | null;
  exportMessages: Record<string, unknown>;
}>();
const t = createTranslator(props.messages);

const query = useQueryState("q");
/** '' = 不限 FIR。 */
const activeFir = useQueryState("fir");
/** 排序键，前缀 `-` 表示降序。 */
const sort = useQueryState("sort", "icao");

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

/** FIR 及其机场数，按机场数降序 —— 大的在前，找起来快。 */
const firChips = computed(() => {
  const counts = new Map<string, number>();
  for (const a of props.airports) {
    if (a.fir) counts.set(a.fir, (counts.get(a.fir) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((x, y) => y[1] - x[1])
    .map(([fir, n]) => ({
      value: fir,
      label: fir,
      count: n,
      color: firColor(fir),
      mono: true,
    }));
});

const filtered = computed(() => {
  const needle = query.value.trim().toUpperCase();
  return props.airports.filter((a) => {
    if (activeFir.value && a.fir !== activeFir.value) return false;
    if (!needle) return true;
    return (
      a.icao.includes(needle) ||
      (a.fir ?? "").includes(needle) ||
      (a.name ?? "").toUpperCase().includes(needle)
    );
  });
});

/** 空值（没有标高）不论升降都排在最后 —— 它们是要单独去看的那一批，不该夹在中间。 */
const shown = computed(() => {
  const { key, desc } = sortState.value;
  const dir = desc ? -1 : 1;
  return [...filtered.value].sort((a, b) => {
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

const filtering = computed(() => !!query.value.trim() || !!activeFir.value);

function clearFilters() {
  query.value = "";
  activeFir.value = "";
}

/** 回车：只剩一个就直接打开。 */
function openSingle() {
  if (shown.value.length === 1) {
    window.location.href = `/airports/${shown.value[0].icao}`;
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
        <!-- 导出跟随筛选，不跟随排序：排序是这一屏怎么看，不是数据。 -->
        <ExportButton
          resource="airports"
          :scope="activeFir || null"
          :rows="filtered"
          :licence="licence"
          :messages="exportMessages"
        />
      </template>
      <template #filters>
        <FilterChips
          v-model="activeFir"
          :chips="firChips"
          :label="t('firFilter')"
          :all-label="t('allFirs')"
          :all-count="airports.length"
        />
      </template>
      <template #count>
        {{
          t("shownCount", {
            n: String(filtered.length),
            total: String(airports.length),
          })
        }}
      </template>
    </ListToolbar>

    <div v-if="!airports.length" class="card">
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
  </div>
</template>
