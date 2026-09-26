<script setup lang="ts">
/**
 * 全网图：机场，可选叠加航路网和某个 FIR 的航路点。
 *
 * ## 取法：按视野，或按 FIR
 *
 * 全库是世界量级（约 1.5 万个机场、9.1 万段航路），不整份取。
 *
 * - **机场**：选了 FIR 就取这个 FIR 的全部（翻页取完，按 FIR 缓存）并把视野收过去；没
 *   选时按视野取（`bbox`，外扩半屏），`AIRPORT_MIN_ZOOM` 级以下不取，一次最多
 *   `AIRPORT_VIEW_CAP` 个，超出时面板里说出来。
 * - **航路网**：开关打开、且缩放到 `AIRWAY_MIN_ZOOM` 级以上时按视野取（`bbox`，外扩半
 *   屏）。视野还在上一次取的盒子里就不重取。`from`/`to` 和 `fixes` 的键是图键
 *   （`AKAGI@RJ/waypoint`），同名的两个点是两个键；显示用 `fromIdent`/`toIdent`。
 * - **航路点**按 FIR 取，而且**只在选中某个 FIR 时**才可取。
 *
 * 平移缩放停下 300 ms 后才按视野取（`moveend` 防抖）。视野跨 180° 时 bbox 写成
 * minLon > maxLon（`lib/viewport.ts` 的 `bboxParam`），画的时候把经度挪到视野中心那一侧
 * （`lonNear`）。
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
import { AlertBox, Icon, Spinner, Toggle } from "@jianyuelab-org/can-ui";
import { createTranslator } from "@/lib/i18n";
import { api } from "@/lib/canDb";
import FilterChips from "@/components/ui/FilterChips.vue";
import SectorLegend from "@/components/map/SectorLegend.vue";
import { useQueryState } from "@/composables/useQueryState";
import { airportsQuery, bboxParam, lonNear } from "@/lib/viewport";
import type {
  AirportSummary,
  AirwayGraph,
  Fix,
  NetworkSector,
  Resolution,
  SectorOwnership,
} from "@/lib/canDb";
import {
  loadBasemap,
  saveBasemap,
  tileSource,
  currentTheme,
  escapeHtml,
  firColor,
  watchTheme,
} from "@/lib/mapBase";
import { basemapControl, nameMarker, viaMarker } from "@/lib/mapMarkers";
// 三条会静默出错的规则住在 lib 里，配了测试：三种状态各一种画法（「没解析过」和「没人
// 管」必须分开）、大的先画小的后画（否则点塔台弹出区调）、圆按半径量。
import { NM_TO_M, drawOrder, sectorPaint, sectorState } from "@/lib/sectorMap";

const props = defineProps<{
  messages: Record<string, unknown>;
  /** 全库机场数（`/aip/overview`）；取不到是 null。 */
  total: number | null;
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

/* ---------------------------------------------------------------------- *
 * 筛选和图层写在地址栏上：`?fir=ZGZU&layers=airways,sectors`
 *
 * 于是「把这一屏发给别人」「刷新之后还在原处」不需要额外代码。FIR 的初值是服务端对着
 * firs 校验过的那一个，先放进去，免得挂载前先画一遍全网再跳过去；挂载后 useQueryState
 * 读到的原值不认识就清掉 —— 和服务端「不认识就当没传」是同一条。
 * ---------------------------------------------------------------------- */
const firParam = useQueryState("fir", "");
firParam.value = props.initialFir ?? "";
/** null = 全部 FIR。只认 firs 里有的 —— 一个乱填的值会筛出一张空图，看起来像数据没了。 */
const activeFir = computed<string | null>(() =>
  props.firs.includes(firParam.value) ? firParam.value : null,
);

const LAYERS = ["airways", "fixes", "sectors"] as const;
type LayerName = (typeof LAYERS)[number];
const layersParam = useQueryState("layers", "");
const layersOn = computed(() => new Set(layersParam.value.split(",")));

function setLayer(name: LayerName, on: boolean) {
  layersParam.value = LAYERS.filter((l) =>
    l === name ? on : layersOn.value.has(l),
  ).join(",");
}
function layerToggle(name: LayerName, needsFir = false) {
  return computed<boolean>({
    // 航路点不选 FIR 不画 —— 地址栏里带着 `fixes` 而没有 FIR，也当它是关的。
    get: () => layersOn.value.has(name) && (!needsFir || !!activeFir.value),
    set: (on) => setLayer(name, on),
  });
}
const showAirways = layerToggle("airways");
const showFixes = layerToggle("fixes", true);
const showSectors = layerToggle("sectors");

/** 手机上面板默认收起 —— 展开的面板会盖住半张图。 */
const panelOpen = ref(true);
/** 在线呼号输入框的原文。解析是**手动触发**的 —— 见 runResolve。 */
const onlineText = ref("");
const loading = ref<string | null>(null);
const failed = ref<string | null>(null);

/** 最近一次按视野取的航路网，和它覆盖的盒子（外扩过的视野）。 */
let airwayCache: AirwayGraph | null = null;
let airwayBox: L.LatLngBounds | null = null;
let airwaySeq = 0;
/** 按 FIR 取的机场，取过就留着。 */
const firAirportCache = new Map<string, AirportSummary[]>();
/** 按视野取的机场和它覆盖的盒子。 */
let viewAirports: AirportSummary[] = [];
let airportBox: L.LatLngBounds | null = null;
let airportSeq = 0;
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

/** 图上正在画的机场。 */
const shownAirports = shallowRef<AirportSummary[]>([]);
/** 视野内机场超过上限，只画了一部分。 */
const airportsCapped = ref(false);
/** 当前缩放。决定机场和航路网取不取、面板里的提示出不出。 */
const zoom = ref(0);

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

/** 机场用 canvas 画：视野里可能有几千个。 */
const airportRenderer = L.canvas({ padding: 0.5 });
/** 上一次画机场时视野中心的经度。平移过了半圈才要按新的一侧重画。 */
let airportRefLon = 0;

function drawAirports() {
  const layer = airportLayer.value;
  const m = map.value;
  if (!layer || !m) return;
  layer.clearLayers();
  const refLon = m.getCenter().lng;
  airportRefLon = refLon;
  for (const a of shownAirports.value) {
    L.circleMarker([a.lat, lonNear(a.lon, refLon)], {
      renderer: airportRenderer,
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

/** 按 FIR 取机场：翻页取完。 */
async function fetchFirAirports(fir: string): Promise<AirportSummary[] | null> {
  const out: AirportSummary[] = [];
  let cursor: string | null = null;
  do {
    const result: Awaited<ReturnType<typeof api<AirportSummary[]>>> = await api<
      AirportSummary[]
    >(`/api/v1/aip/airports?${airportsQuery({ fir, limit: 1000, cursor })}`);
    if (!result.ok) {
      failed.value = result.message;
      return null;
    }
    out.push(...(result.data ?? []));
    cursor = result.nextCursor;
  } while (cursor);
  return out;
}

/**
 * 机场图层。选了 FIR 画这个 FIR 的全部；没选按视野取。`fit` 为真时把视野收到 FIR 上。
 */
async function loadAirports(fit = false) {
  const m = map.value;
  if (!m) return;
  const fir = activeFir.value;
  const seq = ++airportSeq;

  if (fir) {
    let list = firAirportCache.get(fir);
    if (!list) {
      loading.value = String(t("loadingAirports"));
      const fetched = await fetchFirAirports(fir);
      loading.value = null;
      if (!fetched || seq !== airportSeq) return;
      list = fetched;
      firAirportCache.set(fir, list);
    }
    airportsCapped.value = false;
    shownAirports.value = list;
    drawAirports();
    if (fit) fitToShown();
    return;
  }

  if (m.getZoom() < AIRPORT_MIN_ZOOM) {
    airportBox = null;
    viewAirports = [];
    airportsCapped.value = false;
    shownAirports.value = [];
    drawAirports();
    return;
  }
  const view = m.getBounds();
  if (!airportBox || !airportBox.contains(view)) {
    const box = view.pad(0.5);
    loading.value = String(t("loadingAirports"));
    const out: AirportSummary[] = [];
    let cursor: string | null = null;
    let capped = false;
    // 一页 1000，最多取 AIRPORT_VIEW_CAP 个。can-db 按 ICAO 排，超出的那部分说出来。
    do {
      const result: Awaited<ReturnType<typeof api<AirportSummary[]>>> =
        await api<AirportSummary[]>(
          `/api/v1/aip/airports?${airportsQuery({
            bbox: bboxParam(boundsOf(box)),
            limit: 1000,
            cursor,
          })}`,
        );
      if (seq !== airportSeq) return;
      if (!result.ok) {
        loading.value = null;
        failed.value = result.message;
        return;
      }
      out.push(...(result.data ?? []));
      cursor = result.nextCursor;
      if (cursor && out.length >= AIRPORT_VIEW_CAP) {
        capped = true;
        break;
      }
    } while (cursor);
    loading.value = null;
    viewAirports = out;
    // 截断过的盒子不留：放大之后要重取，才画得全。
    airportBox = capped ? null : box;
    airportsCapped.value = capped;
  }
  shownAirports.value = viewAirports;
  drawAirports();
}

function boundsOf(b: L.LatLngBounds) {
  return {
    south: b.getSouth(),
    west: b.getWest(),
    north: b.getNorth(),
    east: b.getEast(),
  };
}

async function drawAirways() {
  const layer = airwayLayer.value;
  const m = map.value;
  if (!layer || !m) return;
  if (!showAirways.value || m.getZoom() < AIRWAY_MIN_ZOOM) {
    layer.clearLayers();
    airwayCache = null;
    airwayBox = null;
    syncLabels();
    return;
  }

  const view = m.getBounds();
  if (!airwayCache || !airwayBox || !airwayBox.contains(view)) {
    const box = view.pad(0.5);
    const seq = ++airwaySeq;
    loading.value = String(t("loadingAirways"));
    const result = await api<AirwayGraph>(
      `/api/v1/aip/airways?bbox=${encodeURIComponent(bboxParam(boundsOf(box)))}`,
    );
    if (seq !== airwaySeq) return;
    loading.value = null;
    if (!result.ok) {
      failed.value = result.message;
      showAirways.value = false;
      return;
    }
    airwayCache = result.data;
    airwayBox = box;
  }

  layer.clearLayers();
  const { fixes, segments } = airwayCache;
  const refLon = m.getCenter().lng;
  // 一条 Polyline 装全部 3065 段，而不是 3065 条 Polyline：后者是三千个 SVG 元素，
  // 平移一次浏览器就要重排三千次。Leaflet 的多段线接受「线的数组」，画出来一样。
  //
  // **一段是个对象，不是三元组。** 这里从前写的是 `for (const [, from, to] of …)`，
  // 而 can-db 给的是 `{airway, from, to, dir, minAlt, maxAlt}` —— 对着普通对象做数组
  // 解构直接抛 TypeError，整个图层一条线都没画出来过。见 `lib/canDb.ts` 的
  // `AirwaySegment`。`dir` 和高度带这里不看：单向和双向在图上是同一条线，而按高度层
  // 筛是 can-db 的路由参数，不是这里的一段 JavaScript。
  //
  // `from`/`to` 是图键，只用来查 `fixes`。两端经度都挪到视野中心那一侧，跨 180° 的
  // 一段才不会横穿整张图。
  const lines: L.LatLngExpression[][] = [];
  for (const { from, to } of segments ?? []) {
    const a = fixes?.[from];
    const b = fixes?.[to];
    if (!a || !b) continue;
    const aLon = lonNear(a[1], refLon);
    lines.push([
      [a[0], aLon],
      [b[0], lonNear(b[1], aLon)],
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

/** 没选 FIR 时，机场从这一级开始按视野取。再往外一屏是几个大洲。 */
const AIRPORT_MIN_ZOOM = 4;
/** 按视野取机场的上限。 */
const AIRPORT_VIEW_CAP = 3000;
/** 航路网从这一级开始按视野取。再往外一屏是几万段。 */
const AIRWAY_MIN_ZOOM = 5;
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

  const level = m.getZoom();
  const bounds = m.getBounds();
  const color = firColor(activeFir.value);

  // 航路名：一条航路在一屏里只标一次，标在它可见的最长一段的中点上。can-radar 在一条
  // 航路上是每段都标的，那里一屏只有一条航路；这里一屏可能有几十条。
  if (showAirways.value && airwayCache && level >= AIRWAY_NAME_ZOOM) {
    const { fixes, segments } = airwayCache;
    const refLon = m.getCenter().lng;
    const best = new Map<string, { mid: [number, number]; len: number }>();
    for (const { airway, from, to } of segments ?? []) {
      const a = fixes?.[from];
      const b = fixes?.[to];
      if (!a || !b) continue;
      const aLon = lonNear(a[1], refLon);
      const bLon = lonNear(b[1], aLon);
      if (!bounds.contains([a[0], aLon]) && !bounds.contains([b[0], bLon]))
        continue;
      const len = Math.hypot(a[0] - b[0], aLon - bLon);
      const prev = best.get(airway);
      if (!prev || len > prev.len) {
        best.set(airway, { mid: [(a[0] + b[0]) / 2, (aLon + bLon) / 2], len });
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
  if (list && level >= FIX_NAME_ZOOM) {
    let drawn = 0;
    const refLon = m.getCenter().lng;
    for (const f of list) {
      if (drawn >= LABEL_CAP) break;
      const lon = lonNear(f.lon, refLon);
      if (!bounds.contains([f.lat, lon])) continue;
      nameMarker(f.lat, lon, f.ident, color).addTo(layer);
      drawn++;
    }
  }
}

/** 把视野收到当前显示的机场上（选 FIR 时）。没有机场时不动 —— 空 bounds 会把图扔到大西洋。 */
function fitToShown() {
  const m = map.value;
  if (!m) return;
  const pts = shownAirports.value.map(
    (a) => [a.lat, a.lon] as L.LatLngExpression,
  );
  if (!pts.length) return;
  m.fitBounds(L.latLngBounds(pts).pad(0.1));
}

let basemap = loadBasemap();

function applyTiles(theme: "dark" | "light") {
  const m = map.value;
  if (!m) return;
  tiles.value?.remove();
  const source = tileSource(basemap, theme);
  tiles.value = L.tileLayer(source.url, {
    attribution: source.attribution,
    maxZoom: 12,
    maxNativeZoom: source.maxNativeZoom,
    // 底图在最下面。不设的话后加的瓦片会盖住已经画好的航路。
    pane: "tilePane",
  }).addTo(m);
}

let stopTheme: (() => void) | null = null;

const DEFAULT_CENTER: L.LatLngExpression = [34, 112];
const DEFAULT_ZOOM = 4;

let moveTimer: ReturnType<typeof setTimeout> | undefined;

/** 名字立刻重建；机场（没选 FIR 时）和航路网停下 300 ms 后按视野取。 */
function onMoveEnd() {
  const m = map.value;
  if (!m) return;
  zoom.value = m.getZoom();
  if (Math.abs(m.getCenter().lng - airportRefLon) > 90) drawAirports();
  syncLabels();
  if (moveTimer !== undefined) clearTimeout(moveTimer);
  moveTimer = setTimeout(() => {
    if (!activeFir.value) void loadAirports();
    void drawAirways();
  }, 300);
}

onMounted(() => {
  // 地址栏里的 FIR 不认识就清掉（useQueryState 的 onMounted 先跑，这时已经读进来了）。
  if (firParam.value && !activeFir.value) firParam.value = "";
  // 没有 FIR 时地址栏里的 `fixes` 也去掉：否则之后一选 FIR，showFixes 和 activeFir 两个
  // watch 会各画一遍航路点。
  if (!activeFir.value && layersOn.value.has("fixes")) setLayer("fixes", false);
  if (window.matchMedia("(max-width: 639px)").matches) panelOpen.value = false;

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
  basemapControl(
    { canvas: t("basemap.canvas"), satellite: t("basemap.satellite") },
    basemap,
    (next) => {
      basemap = next;
      saveBasemap(next);
      applyTiles(currentTheme());
    },
  ).addTo(m);

  // **扇区最先加，所以画在最下面。** 它是成片的填充，压在航路和航路点上面会把它们盖掉。
  sectorLayer.value = L.layerGroup().addTo(m);
  airwayLayer.value = L.layerGroup().addTo(m);
  fixLayer.value = L.layerGroup().addTo(m);
  // 名字在点和线之上、机场之下。
  labelLayer.value = L.layerGroup().addTo(m);
  // 机场最后加，所以画在航路和航路点上面 —— 它们是这张图的主角。
  airportLayer.value = L.layerGroup().addTo(m);

  // 没选 FIR 时的起始视野：本网所在的东亚。选了 FIR，loadAirports 会把视野收过去。
  m.setView(DEFAULT_CENTER, DEFAULT_ZOOM);
  zoom.value = m.getZoom();
  void loadAirports(true);

  // 名字按视野重建，所以平移和缩放都要重来一次 —— 见 syncLabels。按视野取数的那两层
  // 等停下来再取。
  m.on("moveend", onMoveEnd);

  stopTheme = watchTheme(applyTiles);
});

onBeforeUnmount(() => {
  stopTheme?.();
  if (moveTimer !== undefined) clearTimeout(moveTimer);
  map.value?.off("moveend", onMoveEnd);
  map.value?.remove();
  map.value = null;
});

watch(activeFir, () => {
  airportBox = null;
  void loadAirports(true);
  void drawFixes();
  // 扇区按包取，所以换 FIR 要重取（缓存按包分开，来回切不会重下）。
  void drawSectors();
});
watch(showAirways, () => void drawAirways());
watch(showFixes, () => void drawFixes());
watch(showSectors, () => void drawSectors());

/** FilterChips 已经处理了「再点一次等于取消」，这里收到的 '' 就是全部 FIR。 */
function pickFir(fir: string) {
  firParam.value = fir;
  // 全网视图下不给画航路点，所以顺手关掉开关，而不是留一个按了没反应的按钮。
  if (!fir) showFixes.value = false;
}

const firChips = computed(() =>
  props.firs.map((fir) => ({
    value: fir,
    label: fir,
    color: firColor(fir),
    mono: true,
  })),
);
</script>

<template>
  <!-- 地图就是这一页：图占满视口剩下的高度，控件浮在图上。 -->
  <div class="relative">
    <div
      ref="host"
      class="h-[max(26rem,calc(100dvh-16rem))] w-full overflow-hidden rounded-xl border border-subtle"
      role="application"
      :aria-label="String(t('mapLabel'))"
    />

    <!-- 浮动面板放右上：左上是 Leaflet 的缩放按钮。宽度给缩放按钮留出 4.5rem，
         手机上也不会压住它。面板是地图容器的兄弟而不是子节点，所以在面板上点击、
         滚动不会漏给地图。 -->
    <aside
      class="map-panel absolute top-2 right-2 z-[1000] flex max-h-[calc(100%-1rem)] w-[min(20rem,calc(100%-4.5rem))] flex-col"
      :aria-label="String(t('panelTitle'))"
    >
      <div class="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          class="flex min-w-0 flex-1 items-center gap-2 rounded-control text-left text-sm font-medium text-ink focus-visible:shadow-[var(--ring-brand)] focus-visible:outline-none"
          :aria-expanded="panelOpen"
          aria-controls="map-panel-body"
          @click="panelOpen = !panelOpen"
        >
          <Icon name="adjustments" class="size-4 shrink-0 text-muted" />
          <span>{{ t("panelTitle") }}</span>
          <span
            v-if="activeFir"
            class="flex items-center gap-1 font-mono text-xs text-muted"
          >
            <span
              class="chip__dot"
              :style="{ backgroundColor: firColor(activeFir) }"
              aria-hidden="true"
            />
            {{ activeFir }}
          </span>
          <Icon
            name="chevronDown"
            class="ml-auto size-4 shrink-0 text-faint transition-transform"
            :class="panelOpen ? 'rotate-180' : ''"
          />
        </button>
        <!-- 收起时也得看得出在取数据：面板里那一行这时看不见。 -->
        <Spinner v-if="loading && !panelOpen" size="sm" />
      </div>

      <div
        v-show="panelOpen"
        id="map-panel-body"
        class="min-h-0 space-y-4 overflow-y-auto border-t border-subtle p-3"
      >
        <AlertBox
          v-if="failed"
          variant="danger"
          dismissible
          @dismiss="failed = null"
        >
          {{ failed }}
        </AlertBox>
        <Spinner v-if="loading" size="sm" :label="loading" />

        <!-- FIR 筛选。chip 而不是下拉：十几个选项全摆出来，一眼看得到哪个 FIR 机场
             多，而且每个都带着它在图上的颜色（firColor，和清单页同源）。 -->
        <section>
          <h3 class="text-eyebrow mb-2 text-faint">{{ t("firTitle") }}</h3>
          <FilterChips
            :model-value="activeFir ?? ''"
            :chips="firChips"
            :all-label="String(t('allFirs'))"
            :all-count="total ?? undefined"
            :label="String(t('firTitle'))"
            @update:model-value="pickFir"
          />
        </section>

        <section class="space-y-3">
          <h3 class="text-eyebrow text-faint">{{ t("layersTitle") }}</h3>
          <Toggle
            v-model="showAirways"
            :label="String(t('layerAirways'))"
            :description="
              showAirways && zoom < AIRWAY_MIN_ZOOM
                ? String(t('airwaysNeedZoom', { n: String(AIRWAY_MIN_ZOOM) }))
                : undefined
            "
          />
          <!-- 不选 FIR 时是禁用的，并且说为什么 —— 而不是按了没反应。 -->
          <Toggle
            v-model="showFixes"
            :label="String(t('layerFixes'))"
            :description="activeFir ? undefined : String(t('fixesNeedFir'))"
            :disabled="!activeFir"
          />
          <Toggle v-model="showSectors" :label="String(t('layerSectors'))" />
        </section>

        <!-- top-down 归属。**只在扇区图层开着时出现** —— 一个解析出来没地方画的输入框，
             按下去看起来像没反应。**解析是按钮触发的，不是 watch**：见 runResolve。 -->
        <section v-if="showSectors" class="space-y-2.5">
          <h3 class="text-eyebrow text-faint">{{ t("topDownTitle") }}</h3>
          <form class="flex gap-2" @submit.prevent="runResolve">
            <label class="sr-only" for="online">{{ t("onlineLabel") }}</label>
            <input
              id="online"
              v-model="onlineText"
              type="text"
              class="input min-w-0 flex-1 font-mono text-xs uppercase"
              :placeholder="String(t('onlineHint'))"
              autocomplete="off"
              spellcheck="false"
            />
            <button type="submit" class="btn btn-primary shrink-0">
              {{ t("resolveRun") }}
            </button>
          </form>
          <div
            v-if="ownership"
            class="flex flex-wrap items-center justify-between gap-2 text-xs"
          >
            <span class="tnum text-muted">{{ resolveNote }}</span>
            <button type="button" class="link" @click="clearResolve">
              {{ t("resolveClear") }}
            </button>
          </div>

          <!-- 三种状态三种画法。图例的色块走 sectorPaint，和图上同一个函数。 -->
          <SectorLegend
            :package-color="firColor(activeFir)"
            :labels="{
              unresolved: String(t('legendUnresolved')),
              owned: String(t('legendOwned')),
              uncovered: String(t('legendUncovered')),
            }"
          />
        </section>

        <p class="tnum border-t border-subtle pt-3 text-xs text-faint">
          <template v-if="!activeFir && zoom < AIRPORT_MIN_ZOOM">{{
            t("airportsNeedZoom", { n: String(AIRPORT_MIN_ZOOM) })
          }}</template>
          <template v-else-if="airportsCapped">{{
            t("airportsCapped", { n: String(shownAirports.length) })
          }}</template>
          <template v-else>{{
            t("shownCount", { n: String(shownAirports.length) })
          }}</template
          ><template v-if="showSectors">
            ·
            {{
              t("sectorsCount", { n: String(shownSectors.length) })
            }}</template
          >
        </p>
      </div>
    </aside>
  </div>
</template>
