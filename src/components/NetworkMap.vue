<script setup lang="ts">
/**
 * 全网图：233 个机场，可选叠加航路网和某个 FIR 的航路点。
 *
 * ## 三层数据，三种取法，而这不是不一致
 *
 * - **机场**随页面服务端渲染下来（233 条，每条五个字段）。这一层永远要画，先取先画
 *   比开图之后再跑一趟网络快一整个往返。
 * - **航路网**点开才取，因为它是几百 KB 的一整张图 —— 大多数人开这一页只是想看机场
 *   在哪，替他们下一份路网是替他们做了一个他们没做的决定。取一次就留着。
 * - **航路点**按 FIR 取，而且**只在选中某个 FIR 时**才可取。全网 15278 个点画上去是
 *   一团糊，读不出任何东西；限定一个 FIR 之后最多 3914 个（RJJJ），还在能读的范围。
 *
 * ## 它不重建地图
 *
 * 图层组建一次，之后只往里加减 —— 和 can-radar 同一条：重建意味着瓦片重新下载，而
 * 切一次 FIR 筛选就重下一遍整屏瓦片是很显眼的卡顿。
 */
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
} from "vue";
import L from "leaflet";
import { createTranslator } from "@/lib/i18n";
import { api } from "@/lib/canDb";
import type { AirportSummary, AirwayGraph, Fix } from "@/lib/canDb";
import {
  TILES,
  TILE_ATTRIBUTION,
  currentTheme,
  escapeHtml,
  firColor,
  watchTheme,
} from "@/lib/mapBase";

const props = defineProps<{
  messages: Record<string, unknown>;
  airports: AirportSummary[];
  firs: string[];
  /** `/map?fir=…` 带来的初始筛选，已在服务端对着 firs 校验过。 */
  initialFir?: string | null;
}>();
const t = createTranslator(props.messages);

const host = ref<HTMLDivElement | null>(null);
/** shallowRef：Leaflet 的对象是庞大的自引用结构，深响应式代理它既没用又很贵。 */
const map = shallowRef<L.Map | null>(null);
const tiles = shallowRef<L.TileLayer | null>(null);
const airportLayer = shallowRef<L.LayerGroup | null>(null);
const airwayLayer = shallowRef<L.LayerGroup | null>(null);
const fixLayer = shallowRef<L.LayerGroup | null>(null);

/** null = 全部 FIR。 */
const activeFir = ref<string | null>(props.initialFir ?? null);
const showAirways = ref(false);
const showFixes = ref(false);
const loading = ref<string | null>(null);
const failed = ref<string | null>(null);

/** 取过就留着，切 FIR 不该重下一次路网。 */
let airwayCache: AirwayGraph | null = null;
const fixCache = new Map<string, Fix[]>();

const shownAirports = computed(() =>
  activeFir.value
    ? props.airports.filter((a) => a.fir === activeFir.value)
    : props.airports,
);

/** 每个 FIR 有多少机场 —— 筛选条上直接显示，省得点进去才知道是空的。 */
const firCounts = computed(() => {
  const counts = new Map<string, number>();
  for (const a of props.airports) {
    if (a.fir) counts.set(a.fir, (counts.get(a.fir) ?? 0) + 1);
  }
  return counts;
});

function airportPopup(a: AirportSummary): string {
  const name = a.name
    ? `<div class="text-xs opacity-70">${escapeHtml(a.name)}</div>`
    : "";
  const elev = a.elev !== null ? ` · ${a.elev} ft` : "";
  const stands = a.stands
    ? ` · ${a.stands} ${escapeHtml(String(t("standsShort")))}`
    : "";
  return (
    `<div class="font-mono text-sm font-semibold">${escapeHtml(a.icao)}</div>${name}` +
    `<div class="mt-1 text-xs opacity-70">${escapeHtml(a.fir ?? "—")}${elev}${stands}</div>` +
    `<a class="mt-2 inline-block text-xs underline" href="/airports/${encodeURIComponent(a.icao)}">${escapeHtml(String(t("open")))}</a>`
  );
}

function drawAirports() {
  const layer = airportLayer.value;
  if (!layer) return;
  layer.clearLayers();
  for (const a of shownAirports.value) {
    L.circleMarker([a.lat, a.lon], {
      radius: 5,
      color: firColor(a.fir),
      weight: 2,
      fillColor: firColor(a.fir),
      fillOpacity: 0.55,
    })
      .bindPopup(airportPopup(a))
      .bindTooltip(a.icao, { direction: "top", offset: [0, -6] })
      .addTo(layer);
  }
}

async function drawAirways() {
  const layer = airwayLayer.value;
  if (!layer) return;
  layer.clearLayers();
  if (!showAirways.value) return;

  if (!airwayCache) {
    loading.value = String(t("loadingAirways"));
    const result = await api<AirwayGraph>("/api/v1/aip/airways");
    loading.value = null;
    if (!result.ok) {
      failed.value = result.message;
      showAirways.value = false;
      return;
    }
    airwayCache = result.data;
  }

  const { fixes, segments } = airwayCache;
  // 一条 Polyline 装全部 3065 段，而不是 3065 条 Polyline：后者是三千个 SVG 元素，
  // 平移一次浏览器就要重排三千次。Leaflet 的多段线接受「线的数组」，画出来一样。
  const lines: L.LatLngExpression[][] = [];
  for (const [, from, to] of segments) {
    const a = fixes[from];
    const b = fixes[to];
    if (!a || !b) continue;
    lines.push([
      [a[0], a[1]],
      [b[0], b[1]],
    ]);
  }
  L.polyline(lines, {
    color: "#7f8c9b",
    weight: 1,
    opacity: 0.5,
    interactive: false,
  }).addTo(layer);
}

async function drawFixes() {
  const layer = fixLayer.value;
  if (!layer) return;
  layer.clearLayers();
  const fir = activeFir.value;
  if (!showFixes.value || !fir) return;

  let list = fixCache.get(fir);
  if (!list) {
    loading.value = String(t("loadingFixes"));
    const result = await api<Fix[]>(
      `/api/v1/aip/fixes?fir=${encodeURIComponent(fir)}`,
    );
    loading.value = null;
    if (!result.ok) {
      failed.value = result.message;
      showFixes.value = false;
      return;
    }
    list = result.data ?? [];
    fixCache.set(fir, list);
  }

  // 航路点用 circleMarker 而不是 marker：后者每个都是一个 <img> 加一个 DOM 节点，
  // 三千多个足以让平移掉帧。
  for (const f of list) {
    L.circleMarker([f.lat, f.lon], {
      radius: 2,
      color: firColor(fir),
      weight: 1,
      opacity: 0.7,
      fillOpacity: 0.7,
    })
      .bindTooltip(f.ident, { direction: "top", offset: [0, -4] })
      .addTo(layer);
  }
}

/** 把视野收到当前显示的机场上。没有机场时不动 —— 空 bounds 会把图扔到大西洋。 */
function fitToShown() {
  const m = map.value;
  if (!m) return;
  const pts = shownAirports.value.map(
    (a) => [a.lat, a.lon] as L.LatLngExpression,
  );
  if (!pts.length) return;
  m.fitBounds(L.latLngBounds(pts).pad(0.1));
}

function applyTiles(theme: "dark" | "light") {
  const m = map.value;
  if (!m) return;
  tiles.value?.remove();
  tiles.value = L.tileLayer(TILES[theme], {
    attribution: TILE_ATTRIBUTION,
    maxZoom: 12,
    // 底图在最下面。不设的话后加的瓦片会盖住已经画好的航路。
    pane: "tilePane",
  }).addTo(m);
}

let stopTheme: (() => void) | null = null;

onMounted(() => {
  if (!host.value) return;
  const m = L.map(host.value, {
    zoomControl: true,
    attributionControl: true,
    // 世界地图在低缩放会横向重复，机场就会出现好几份。
    worldCopyJump: false,
    minZoom: 2,
    maxZoom: 12,
  });
  map.value = m;
  applyTiles(currentTheme());

  airwayLayer.value = L.layerGroup().addTo(m);
  fixLayer.value = L.layerGroup().addTo(m);
  // 机场最后加，所以画在航路和航路点上面 —— 它们是这张图的主角。
  airportLayer.value = L.layerGroup().addTo(m);

  drawAirports();
  fitToShown();

  stopTheme = watchTheme(applyTiles);
});

onBeforeUnmount(() => {
  stopTheme?.();
  map.value?.remove();
  map.value = null;
});

watch(activeFir, () => {
  drawAirports();
  fitToShown();
  void drawFixes();
});
watch(showAirways, () => void drawAirways());
watch(showFixes, () => void drawFixes());

function pickFir(fir: string | null) {
  activeFir.value = activeFir.value === fir ? null : fir;
  // 全网视图下不给画航路点，所以顺手关掉开关，而不是留一个按了没反应的按钮。
  if (!activeFir.value) showFixes.value = false;
}
</script>

<template>
  <div class="flex flex-col gap-3">
    <!-- FIR 筛选。用 button 而不是 select：11 个选项全摆出来，一眼看得到哪个 FIR
         机场多，而且每个都带着它在图上的颜色。 -->
    <div class="flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        class="rounded-full border px-2.5 py-1 text-xs transition"
        :class="
          activeFir === null
            ? 'border-can bg-can/10 text-ink'
            : 'border-line text-muted hover:border-can/40'
        "
        @click="pickFir(null)"
      >
        {{ t("allFirs") }}
        <span class="tnum opacity-60">{{ airports.length }}</span>
      </button>

      <button
        v-for="fir in firs"
        :key="fir"
        type="button"
        class="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition"
        :class="
          activeFir === fir
            ? 'border-can bg-can/10 text-ink'
            : 'border-line text-muted hover:border-can/40'
        "
        @click="pickFir(fir)"
      >
        <span
          class="inline-block size-2 rounded-full"
          :style="{ backgroundColor: firColor(fir) }"
          aria-hidden="true"
        />
        <span class="font-mono">{{ fir }}</span>
        <span class="tnum opacity-60">{{ firCounts.get(fir) ?? 0 }}</span>
      </button>
    </div>

    <div class="flex flex-wrap items-center gap-4 text-xs text-muted">
      <label class="flex items-center gap-2">
        <input v-model="showAirways" type="checkbox" class="accent-can" />
        {{ t("layerAirways") }}
      </label>
      <label
        class="flex items-center gap-2"
        :class="activeFir ? '' : 'cursor-not-allowed opacity-50'"
        :title="activeFir ? undefined : String(t('fixesNeedFir'))"
      >
        <input
          v-model="showFixes"
          type="checkbox"
          class="accent-can"
          :disabled="!activeFir"
        />
        {{ t("layerFixes") }}
      </label>
      <span v-if="loading" class="text-faint">{{ loading }}</span>
      <span v-if="failed" class="text-danger">{{ failed }}</span>
    </div>

    <div
      ref="host"
      class="h-[clamp(24rem,68vh,46rem)] w-full overflow-hidden rounded-xl border border-line"
      role="application"
      :aria-label="String(t('mapLabel'))"
    />

    <p class="text-xs text-faint">
      {{ t("shownCount", { n: String(shownAirports.length) }) }}
    </p>
  </div>
</template>
