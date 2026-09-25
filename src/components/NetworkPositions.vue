<script setup lang="ts">
/**
 * 本网实际开的席位 —— 扇区包 `[POSITIONS]` 里的那一份。
 *
 * **和汇编那份分开显示，因为它们回答的不是同一个问题。** 汇编那边是官方怎么划扇区（594
 * 个，只有区域和进近）；这一份是成员登录时用的呼号、频率、二次雷达码段，塔台、地面、放
 * 行、ATIS 只有这边有。合成一张表会让「有多少个席位」这个问题答不清楚。
 *
 * ## 呼号不唯一，这不是脏数据
 *
 * `RJTG_CTR` 有 19 条，标识 TG/T01…T27 各管一个扇区 —— EuroScope 靠标识把扇区归属解析回
 * 呼号。所以按呼号分组显示：一行是一个呼号，展开才看它下面的标识和频率。只有一条的呼号
 * 没有可展开的东西，那一行的按钮是禁用的，不是按了没反应。
 *
 * 搜索词、扇区包和席位类型都挂在地址栏上（`?q=`、`?fir=`、`?facility=`）。扇区包的名字
 * 就是 FIR 代号，所以查询键和另外两页一样叫 `fir`。
 */
import { computed, ref } from "vue";
import { EmptyState, Icon } from "@jianyuelab-org/can-ui";
import { createTranslator } from "@/lib/i18n";
import { firColor } from "@/lib/mapBase";
import type { Licence, NetworkPosition } from "@/lib/canDb";
import { useQueryState } from "@/composables/useQueryState";
import ExportButton from "@/components/ExportButton.vue";
import SearchField from "@/components/ui/SearchField.vue";
import FilterChips from "@/components/ui/FilterChips.vue";
import ListToolbar from "@/components/lists/ListToolbar.vue";

const props = defineProps<{
  messages: Record<string, unknown>;
  positions: NetworkPosition[];
  licence: Licence | null;
  exportMessages: Record<string, unknown>;
}>();
const t = createTranslator(props.messages);

/** 席位类型按管制链条排，不按字母 —— 放行、地面、塔台、进近、区域是它的自然顺序。 */
const FACILITY_ORDER = [
  "DEL",
  "GND",
  "RMP",
  "TWR",
  "APP",
  "DEP",
  "GCA",
  "CTR",
  "FSS",
  "ATIS",
];

const facility = useQueryState("facility");
const pkg = useQueryState("fir");
const query = useQueryState("q");
const open = ref<Set<string>>(new Set());

const facilityChips = computed(() => {
  const seen = new Map<string, number>();
  for (const p of props.positions)
    seen.set(p.facility, (seen.get(p.facility) ?? 0) + 1);
  return FACILITY_ORDER.filter((f) => seen.has(f)).map((f) => ({
    value: f,
    label: f,
    count: seen.get(f) ?? 0,
    mono: true,
  }));
});

/** 按**归属包**数，和下面的筛子同一个口径。 */
const packageChips = computed(() => {
  const seen = new Map<string, number>();
  for (const p of props.positions)
    seen.set(p.package, (seen.get(p.package) ?? 0) + 1);
  return [...seen.keys()].sort().map((p) => ({
    value: p,
    label: p,
    count: seen.get(p) ?? 0,
    color: firColor(p),
    mono: true,
  }));
});

const totalCallsigns = computed(
  () => new Set(props.positions.map((p) => p.callsign)).size,
);

/**
 * 筛选之后、按呼号分组**之前**的平铺数组 —— 导出用这一份，不是 `groups`。
 * 分组是渲染，导出要平的。
 */
const filtered = computed(() => {
  const needle = query.value.trim().toUpperCase();
  return props.positions.filter((p) => {
    if (facility.value && p.facility !== facility.value) return false;
    // **按归属包筛,不按 also_in。** 一个席位只由归属包定义为准,邻包的副本只是对账
    // 用的;把 also_in 也算进来,选 ZSHA 会筛出一批实际归 RKRR 的席位。
    if (pkg.value && p.package !== pkg.value) return false;
    if (
      needle &&
      !p.callsign.toUpperCase().includes(needle) &&
      !(p.radioName ?? "").toUpperCase().includes(needle) &&
      !(p.identifier ?? "").toUpperCase().includes(needle) &&
      !String(p.freqMhz ?? "").includes(needle)
    ) {
      return false;
    }
    return true;
  });
});

/** 按呼号分组：一个呼号一行，下面挂它的标识。 */
const groups = computed(() => {
  const byCallsign = new Map<string, NetworkPosition[]>();

  for (const p of filtered.value) {
    const list = byCallsign.get(p.callsign);
    if (list) list.push(p);
    else byCallsign.set(p.callsign, [p]);
  }

  return [...byCallsign.entries()]
    .map(([callsign, list]) => ({ callsign, list }))
    .sort((a, b) => a.callsign.localeCompare(b.callsign));
});

const filtering = computed(
  () => !!query.value.trim() || !!pkg.value || !!facility.value,
);

function clearFilters() {
  query.value = "";
  pkg.value = "";
  facility.value = "";
}

function toggle(callsign: string) {
  const next = new Set(open.value);
  if (next.has(callsign)) next.delete(callsign);
  else next.add(callsign);
  open.value = next;
}

/** 一个呼号下的频率：一个就直接印，多个印「N 个频率」—— 那是分扇区的区调。 */
function freqSummary(list: NetworkPosition[]): string {
  const freqs = [...new Set(list.map((p) => p.freqMhz).filter(Boolean))];
  if (freqs.length === 0) return "—";
  if (freqs.length === 1) return String(freqs[0]);
  return String(t("nFreqs", { n: String(freqs.length) }));
}

/** 一个呼号下的归属包。几乎总是一个；不止一个就都印出来，不挑。 */
function packagesOf(list: NetworkPosition[]): string {
  return [...new Set(list.map((p) => p.package))].join(" · ");
}

function alsoInCount(p: NetworkPosition): number {
  return p.alsoIn ? p.alsoIn.split(",").length : 0;
}

/** 呼号拿来当元素 id 之前，把字母数字、下划线、连字符以外的字符换掉。 */
function panelId(callsign: string) {
  return `np-${callsign.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}
</script>

<template>
  <div>
    <ListToolbar>
      <template #search>
        <SearchField
          v-model="query"
          :label="t('search')"
          :placeholder="String(t('searchHint'))"
        />
      </template>
      <template #actions>
        <ExportButton
          resource="positions"
          :scope="pkg || null"
          :rows="filtered"
          :licence="licence"
          :messages="exportMessages"
        />
      </template>
      <template #filters>
        <FilterChips
          v-model="pkg"
          :chips="packageChips"
          :label="t('package')"
          :all-label="t('allPackages')"
          :all-count="positions.length"
        />
        <FilterChips
          v-model="facility"
          :chips="facilityChips"
          :label="t('facility')"
          :all-label="t('allFacilities')"
          :all-count="positions.length"
        />
      </template>
      <template #count>
        <template v-if="filtering">{{
          t("showingOf", {
            callsigns: String(groups.length),
            totalCallsigns: String(totalCallsigns),
            seats: String(filtered.length),
            totalSeats: String(positions.length),
          })
        }}</template>
        <template v-else>{{
          t("showing", {
            callsigns: String(groups.length),
            seats: String(filtered.length),
          })
        }}</template>
      </template>
    </ListToolbar>

    <div v-if="!groups.length" class="card">
      <EmptyState
        :title="positions.length ? t('none') : t('noData')"
        icon="signal"
        compact
      >
        <template v-if="filtering" #action>
          <button type="button" class="btn btn-secondary" @click="clearFilters">
            {{ t("clearFilters") }}
          </button>
        </template>
      </EmptyState>
    </div>

    <ul v-else class="card divide-y divide-[var(--border-subtle)] p-0">
      <li v-for="g in groups" :key="g.callsign">
        <button
          type="button"
          class="flex w-full items-center gap-3 px-3 py-2.5 text-left transition enabled:cursor-pointer enabled:hover:bg-[var(--surface-hover)] focus-visible:shadow-[var(--ring-brand)] focus-visible:outline-none sm:px-4"
          :disabled="g.list.length === 1"
          :aria-expanded="g.list.length > 1 ? open.has(g.callsign) : undefined"
          :aria-controls="g.list.length > 1 ? panelId(g.callsign) : undefined"
          @click="toggle(g.callsign)"
        >
          <!-- 单行的呼号也留出这一格，所有行的呼号才对得齐。 -->
          <span class="flex size-4 shrink-0 items-center text-faint">
            <Icon
              v-if="g.list.length > 1"
              name="chevronRight"
              class="size-4 transition-transform"
              :class="{ 'rotate-90 text-ink': open.has(g.callsign) }"
            />
          </span>
          <span class="badge badge-neutral w-14 shrink-0 justify-center">{{
            g.list[0].facility
          }}</span>

          <span class="flex min-w-0 flex-1 flex-col">
            <span class="font-mono text-sm font-semibold text-ink">{{
              g.callsign
            }}</span>
            <span
              v-if="g.list[0].radioName"
              class="truncate text-xs text-muted"
              >{{ g.list[0].radioName }}</span
            >
          </span>

          <span class="flex shrink-0 flex-col items-end">
            <span class="tnum font-mono text-base font-semibold text-ink">{{
              freqSummary(g.list)
            }}</span>
            <span
              class="flex items-center gap-1.5 text-xs whitespace-nowrap text-faint"
            >
              <!-- 一个呼号带多个标识 = 分扇区的区调，这一点值得在收起时就看得见。 -->
              <span v-if="g.list.length > 1">{{
                t("nSectors", { n: String(g.list.length) })
              }}</span>
              <span v-if="g.list.length > 1" aria-hidden="true">·</span>
              <span class="font-mono">{{ packagesOf(g.list) }}</span>
              <span
                v-if="g.list.length === 1 && alsoInCount(g.list[0])"
                :title="t('alsoInHint')"
                class="badge badge-neutral tnum"
                >+{{ alsoInCount(g.list[0]) }}</span
              >
            </span>
          </span>
        </button>

        <div
          v-if="open.has(g.callsign) && g.list.length > 1"
          :id="panelId(g.callsign)"
          class="scroll-shadow-x overflow-x-auto border-t border-subtle bg-surface-sunken px-3 py-2 sm:px-4"
        >
          <table class="data-table w-full text-sm">
            <thead>
              <tr>
                <th>{{ t("identifier") }}</th>
                <th>{{ t("freq") }}</th>
                <th>{{ t("squawk") }}</th>
                <th>{{ t("package") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(p, i) in g.list" :key="i">
                <td :data-label="t('identifier')" class="font-mono">
                  {{ p.identifier ?? "—" }}
                </td>
                <td :data-label="t('freq')" class="tnum font-mono">
                  {{ p.freqMhz ?? "—" }}
                </td>
                <td :data-label="t('squawk')" class="tnum font-mono text-xs">
                  {{ p.squawkStart ? `${p.squawkStart}–${p.squawkEnd}` : "—" }}
                </td>
                <td :data-label="t('package')" class="text-xs text-faint">
                  <span class="font-mono">{{ p.package }}</span>
                  <span
                    v-if="p.alsoIn"
                    :title="t('alsoInHint')"
                    class="badge badge-neutral tnum ml-1.5"
                    >+{{ alsoInCount(p) }}</span
                  >
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </li>
    </ul>
  </div>
</template>
