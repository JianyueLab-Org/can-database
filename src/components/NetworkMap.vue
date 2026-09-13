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
import type {
  AirportSummary,
  AirwayGraph,
  Fix,
  NetworkSector,
  Resolution,
  SectorOwnership,
} from "@/lib/canDb";
import {
  TILES,
  TILE_ATTRIBUTION,
  TILE_MAX_NATIVE_ZOOM,
  currentTheme,
  escapeHtml,
  firColor,
  watchTheme,
} from "@/lib/mapBase";
import { nameMarker, viaMarker } from "@/lib/mapMarkers";
// 三条会静默出错的规则住在 lib 里，配了测试：三种状态各一种画法（「没解析过」和「没人
// 管」必须分开）、大的先画小的后画（否则点塔台弹出区调）、圆按半径量。
import { NM_TO_M, drawOrder, sectorPaint, sectorState } from "@/lib/sectorMap";

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
const sectorLayer = shallowRef<L.LayerGroup | null>(null);
/** 名字单独一层：它按视野重建，而点和线不用。 */
const labelLayer = shallowRef<L.LayerGroup | null>(null);

/** null = 全部 FIR。 */
const activeFir = ref<string | null>(props.initialFir ?? null);
const showAirways = ref(false);
const showFixes = ref(false);
const showSectors = ref(false);
/** 在线呼号输入框的原文。解析是**手动触发**的 —— 见 runResolve。 */
const onlineText = ref("");
const loading = ref<string | null>(null);
const failed = ref<string | null>(null);

/** 取过就留着，切 FIR 不该重下一次路网。 */
let airwayCache: AirwayGraph | null = null;
const fixCache = new Map<string, Fix[]>();
/** 按包缓存。键是包名，全网那份用 `*` —— 空串会和「没选」混淆。 */
const sectorCache = new Map<string, NetworkSector[]>();

/* ---------------------------------------------------------------------- *
 * top-down 归属
 *
 * **规则不在这里。** 「沿链找第一个在线的」写在 can-db 的 `ResolveTopDown` 里，这一页
 * 只是把它的答案上色 —— 控制台要列、排班要用、在线图要画，三处各实现一遍迟早不一致。
 *
 * `ownership` 为空表示**没解析过**，和「解析过但没人管」是两件事：前者画包色，后者画
 * 成红色虚线。这两种在地图上长得一样正是 can-db 显式返回 `uncovered` 的理由，所以这
 * 里不能把它们合成一个「没有颜色」。
 * ---------------------------------------------------------------------- */
const ownership = shallowRef<Map<number, SectorOwnership> | null>(null);
const resolveNote = ref<string | null>(null);

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
  //
  // **一段是个对象，不是三元组。** 这里从前写的是 `for (const [, from, to] of …)`，
  // 而 can-db 给的是 `{airway, from, to, dir, minAlt, maxAlt}` —— 对着普通对象做数组
  // 解构直接抛 TypeError，整个图层一条线都没画出来过。见 `lib/canDb.ts` 的
  // `AirwaySegment`。`dir` 和高度带这里不看：单向和双向在图上是同一条线，而按高度层
  // 筛是 can-db 的路由参数，不是这里的一段 JavaScript。
  const lines: L.LatLngExpression[][] = [];
  for (const { from, to } of segments) {
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
  syncLabels();
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
  // 三千多个足以让平移掉帧。**名字不挂 tooltip** —— 见 syncLabels。
  for (const f of list) {
    L.circleMarker([f.lat, f.lon], {
      radius: 2,
      color: firColor(fir),
      weight: 1,
      opacity: 0.7,
      fillOpacity: 0.7,
    }).addTo(layer);
  }
  syncLabels();
}

/* ---------------------------------------------------------------------- *
 * 扇区图层
 *
 * 画的是**我们实际划的**那 569 块（`network_sector`，扇区包的 `[AIRSPACE]`），不是汇编
 * 发布的 594 个管制扇区。几何是 can-db 在导入时拼好的：共享边按端点接成闭环，容差 11cm
 * 是量出来的下界。这里一条几何都不算 —— 算了就等于把「规则在导入时定」又搬回查询时。
 * ---------------------------------------------------------------------- */

function sectorPopup(sc: NetworkSector): string {
  const band = `${sc.floorFt}–${sc.ceilingFt} ft`;
  const own = ownership.value?.get(sc.id);

  // **走和上色同一个判据。** 两处各判一遍，就会出现「画成没人管、弹窗里什么都不说」
  // 这种不一致（`uncovered=false` 而 `owner` 为 null 时正是如此）。
  let verdict = "";
  switch (sectorState(own)) {
    case "uncovered":
      verdict = `<div class="mt-1 text-xs" style="color:#e05252">${escapeHtml(String(t("uncovered")))}</div>`;
      break;
    case "owned":
      verdict =
        `<div class="mt-1 text-xs">${escapeHtml(String(t("ownedBy")))} ` +
        `<span class="font-mono font-semibold">${escapeHtml(own!.owner!)}</span>` +
        `<span class="opacity-60"> · rank ${own!.rank}</span></div>`;
      break;
    default:
      break;
  }

  // **悬空的一环画成「解析不到」，不跳过。** callsign 为 null 表示这个标识在它那个包里
  // 找不到席位（全库 46 处）；跳过它会让 rank 出现空洞，而 rank 就是 top-down 的意义。
  const chain = sc.owners.length
    ? `<div class="mt-2 text-xs opacity-70">${escapeHtml(String(t("sectorChain")))}</div>` +
      `<ol class="mt-0.5 text-xs">` +
      sc.owners
        .map(
          (o) =>
            `<li><span class="opacity-50">${o.rank}</span> ` +
            (o.callsign
              ? `<span class="font-mono">${escapeHtml(o.callsign)}</span>`
              : `<span class="font-mono opacity-50" title="${escapeHtml(String(t("sectorDangling")))}">${escapeHtml(o.identifier)} ?</span>`) +
            `</li>`,
        )
        .join("") +
      `</ol>`
    : "";

  return (
    `<div class="font-mono text-sm font-semibold">${escapeHtml(sc.name)}</div>` +
    `<div class="mt-1 text-xs opacity-70">${escapeHtml(sc.facility)} · ${escapeHtml(sc.package)} · ${band}</div>` +
    verdict +
    chain
  );
}

const shownSectors = shallowRef<NetworkSector[]>([]);

async function drawSectors() {
  const layer = sectorLayer.value;
  if (!layer) return;
  layer.clearLayers();
  shownSectors.value = [];
  if (!showSectors.value) return;

  // **按包取，不是取全部再在浏览器里筛。** 包名就是 FIR 代号（ZBPE、RJJJ…），所以
  // FIR 筛选条直接就是它的筛子；选了 FIR 只下那一个包，省掉 569 块里用不上的那些。
  const key = activeFir.value ?? "*";
  let list = sectorCache.get(key);
  if (!list) {
    loading.value = String(t("loadingSectors"));
    const path =
      key === "*"
        ? "/api/v1/aip/sectors/network"
        : `/api/v1/aip/sectors/network?package=${encodeURIComponent(key)}`;
    const result = await api<NetworkSector[]>(path);
    loading.value = null;
    if (!result.ok) {
      failed.value = result.message;
      showSectors.value = false;
      return;
    }
    list = result.data ?? [];
    sectorCache.set(key, list);
  }
  shownSectors.value = list;

  for (const sc of drawOrder(list)) {
    const style = sectorPaint(
      ownership.value?.get(sc.id),
      firColor(sc.package),
    );
    const shape =
      sc.shape === "circle"
        ? sc.centreLat !== null && sc.centreLon !== null && sc.radiusNm !== null
          ? L.circle([sc.centreLat, sc.centreLon], {
              ...style,
              radius: sc.radiusNm * NM_TO_M,
            })
          : null
        : sc.vertices.length
          ? L.polygon(sc.vertices as L.LatLngExpression[], style)
          : null;
    // 几何缺失不画，也不假装。can-db 那边 569 块是 0 失败，所以这里为 null 就是接口
    // 变了或者数据坏了，不是常态。
    if (!shape) continue;
    shape.bindPopup(sectorPopup(sc)).addTo(layer);
  }
}

/**
 * 跑一次 top-down 解析。
 *
 * **是按钮不是 watch。** 每敲一个字符打一次接口，中间态（`ZBAA_CT`）是一个不存在的呼
 * 号，图会在打字过程中闪成一片「没人管」—— 而「没人管」是这张图上最需要可信的那个状态。
 */
async function runResolve() {
  const online = onlineText.value
    .split(/[,\s]+/)
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);

  loading.value = String(t("resolving"));
  const result = await api<Resolution>(
    `/api/v1/aip/sectors/network/resolve?online=${encodeURIComponent(online.join(","))}`,
  );
  loading.value = null;
  if (!result.ok) {
    failed.value = result.message;
    return;
  }
  const list = result.data?.sectors ?? [];
  ownership.value = new Map(list.map((o) => [o.id, o]));
  const uncovered = list.filter((o) => o.uncovered).length;
  resolveNote.value = String(
    t("resolveSummary", {
      owned: String(list.length - uncovered),
      uncovered: String(uncovered),
    }),
  );
  void drawSectors();
}

function clearResolve() {
  ownership.value = null;
  resolveNote.value = null;
  onlineText.value = "";
  void drawSectors();
}

/* ---------------------------------------------------------------------- *
 * 名字：视野内、够放大、有上限
 *
 * can-radar 的读法是「名字建在 marker 里，用缩放开关一个 class」—— 那是给**一条航
 * 路**几十个点写的。这张图上是 3914 个航路点和 11988 段航路，全建成 divIcon 会掉帧
 * （点之所以是 circleMarker 就是这个原因）。
 *
 * 所以同一套读法换个落地方式：**只给视野内的画名字**，够放大才画，而且有上限。三个
 * 条件缺一不可 —— 少了视野就是全网几千个标签，少了缩放就是缩到看不清时糊成一片，少
 * 了上限就是有人放大到一个航路枢纽上时突然几百个标签。
 * ---------------------------------------------------------------------- */

/** 航路点名字从这一级开始画。 */
const FIX_NAME_ZOOM = 8;
/** 航路名从这一级开始画 —— 比点早，少而关键。 */
const AIRWAY_NAME_ZOOM = 7;
/** 一屏最多画多少个标签。超出就不画，宁可少也不糊。 */
const LABEL_CAP = 160;

function syncLabels() {
  const m = map.value;
  const layer = labelLayer.value;
  if (!m || !layer) return;
  layer.clearLayers();

  const zoom = m.getZoom();
  const bounds = m.getBounds();
  const color = firColor(activeFir.value);

  // 航路名：一条航路在一屏里只标一次，标在它可见的最长一段的中点上。can-radar 在一条
  // 航路上是每段都标的，那里一屏只有一条航路；这里一屏可能有几十条。
  if (showAirways.value && airwayCache && zoom >= AIRWAY_NAME_ZOOM) {
    const { fixes, segments } = airwayCache;
    const best = new Map<string, { mid: [number, number]; len: number }>();
    for (const { airway, from, to } of segments) {
      const a = fixes[from];
      const b = fixes[to];
      if (!a || !b) continue;
      if (!bounds.contains([a[0], a[1]]) && !bounds.contains([b[0], b[1]]))
        continue;
      const len = Math.hypot(a[0] - b[0], a[1] - b[1]);
      const prev = best.get(airway);
      if (!prev || len > prev.len) {
        best.set(airway, { mid: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], len });
      }
    }
    let drawn = 0;
    for (const [airway, { mid }] of best) {
      if (drawn >= LABEL_CAP) break;
      viaMarker(mid[0], mid[1], airway, "#7f8c9b").addTo(layer);
      drawn++;
    }
  }

  // 航路点名字。
  const fir = activeFir.value;
  const list = showFixes.value && fir ? fixCache.get(fir) : null;
  if (list && zoom >= FIX_NAME_ZOOM) {
    let drawn = 0;
    for (const f of list) {
      if (drawn >= LABEL_CAP) break;
      if (!bounds.contains([f.lat, f.lon])) continue;
      nameMarker(f.lat, f.lon, f.ident, color).addTo(layer);
      drawn++;
    }
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
    maxNativeZoom: TILE_MAX_NATIVE_ZOOM,
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

  // **扇区最先加，所以画在最下面。** 它是成片的填充，压在航路和航路点上面会把它们盖掉。
  sectorLayer.value = L.layerGroup().addTo(m);
  airwayLayer.value = L.layerGroup().addTo(m);
  fixLayer.value = L.layerGroup().addTo(m);
  // 名字在点和线之上、机场之下。
  labelLayer.value = L.layerGroup().addTo(m);
  // 机场最后加，所以画在航路和航路点上面 —— 它们是这张图的主角。
  airportLayer.value = L.layerGroup().addTo(m);

  drawAirports();
  fitToShown();

  // 名字按视野重建，所以平移和缩放都要重来一次 —— 见 syncLabels。
  m.on("moveend", syncLabels);
  m.on("zoomend", syncLabels);

  stopTheme = watchTheme(applyTiles);
});

onBeforeUnmount(() => {
  stopTheme?.();
  map.value?.off("moveend", syncLabels);
  map.value?.off("zoomend", syncLabels);
  map.value?.remove();
  map.value = null;
});

watch(activeFir, () => {
  drawAirports();
  fitToShown();
  void drawFixes();
  // 扇区按包取，所以换 FIR 要重取（缓存按包分开，来回切不会重下）。
  void drawSectors();
});
watch(showAirways, () => void drawAirways());
watch(showFixes, () => void drawFixes());
watch(showSectors, () => void drawSectors());

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
      <label class="flex items-center gap-2">
        <input v-model="showSectors" type="checkbox" class="accent-can" />
        {{ t("layerSectors") }}
      </label>
      <span v-if="loading" class="text-faint">{{ loading }}</span>
      <span v-if="failed" class="text-danger">{{ failed }}</span>
    </div>

    <!-- top-down 归属。**只在扇区图层开着时出现** —— 一个解析出来没地方画的输入框，
         按下去看起来像没反应。 -->
    <div
      v-if="showSectors"
      class="flex flex-wrap items-center gap-2 text-xs text-muted"
    >
      <label class="sr-only" for="online">{{ t("onlineLabel") }}</label>
      <input
        id="online"
        v-model="onlineText"
        type="text"
        class="min-w-64 flex-1 rounded-lg border border-line bg-transparent px-2.5 py-1 font-mono text-xs"
        :placeholder="String(t('onlineHint'))"
        @keyup.enter="runResolve"
      />
      <button
        type="button"
        class="rounded-lg border border-can px-2.5 py-1 text-xs text-ink transition hover:bg-can/10"
        @click="runResolve"
      >
        {{ t("resolveRun") }}
      </button>
      <button
        v-if="ownership"
        type="button"
        class="rounded-lg border border-line px-2.5 py-1 text-xs transition hover:border-can/40"
        @click="clearResolve"
      >
        {{ t("resolveClear") }}
      </button>
      <span v-if="resolveNote" class="text-faint">{{ resolveNote }}</span>
    </div>

    <div
      ref="host"
      class="h-[clamp(24rem,68vh,46rem)] w-full overflow-hidden rounded-xl border border-line"
      role="application"
      :aria-label="String(t('mapLabel'))"
    />

    <p class="text-xs text-faint">
      {{ t("shownCount", { n: String(shownAirports.length) })
      }}<template v-if="showSectors">
        · {{ t("sectorsCount", { n: String(shownSectors.length) }) }}</template
      >
    </p>
  </div>
</template>
