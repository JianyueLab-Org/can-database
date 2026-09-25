<script setup lang="ts">
/**
 * 一个机场的地面要素编辑器 —— 只给 5 级。
 *
 * 读 `GET …/ground/source`（原始精度；404 表示这个机场还没有，从空白开始画），存
 * `PUT …/ground`（整份替换），导出 `GET …/ground.json`（Ground 仓库格式）。三条都在
 * can-db 走 `withWrite`。
 *
 * **保存只进了资料库。** 地面要素的源头是 Ground 仓库，扇区地面导入会拿它把库里这一份
 * 整个盖掉 —— 所以保存成功后的提示要一直说「导出并提交到 Ground/<FIR>/airports/」，
 * 不是一句「已保存」就完事。
 *
 * 模型、命中判断、撤销栈和校验在 `src/lib/groundEdit.ts`（纯函数，有测试）；这里只管
 * Leaflet 和鼠标键盘。画法（颜色、线宽）和机场图共用 `src/lib/groundStyle.ts`。
 *
 * ## 鼠标事件怎么分
 *
 * - 拖顶点、Alt+点顶点：容器上的**捕获阶段** `mousedown`。命中选中要素的顶点时
 *   `stopPropagation`，Leaflet 的拖动平移根本收不到这一下 —— 否则拖顶点的同时地图也在
 *   跟着走。没命中就放过去，于是拖空白处照常平移。
 * - 选中、加点：Leaflet 的 `click`。它只在没拖动时触发，平移结束不会误选、误加点。
 * - 插点、结束绘制：Leaflet 的 `dblclick`（地图的双击缩放关掉了）。
 *
 * 图层全部 `interactive: false`，命中判断一律在屏幕坐标里由 `groundEdit` 做 —— 一个点
 * 上摞着场界、机坪、滑行道时，Leaflet 只会把点击给最上面那一个，而这里要的是最具体的那
 * 一个。
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
import { AlertBox, Dialog, Icon, Spinner } from "@jianyuelab-org/can-ui";
import { createTranslator } from "@/lib/i18n";
import { basemapControl } from "@/lib/mapMarkers";
import {
  api,
  importGroundOsm,
  previewGroundOsm,
  type GroundOsmPreview,
} from "@/lib/canDb";
import {
  loadBasemap,
  saveBasemap,
  tileSource,
  currentTheme,
  watchTheme,
} from "@/lib/mapBase";
import {
  FEATURE_FALLBACK,
  FEATURE_STYLE,
  LABEL_KINDS,
  drawRank,
} from "@/lib/groundStyle";
import { escapeHtml } from "@/lib/mapBase";
import {
  EditHistory,
  GROUND_KINDS,
  POINT_KINDS,
  addFeature,
  deleteFeature,
  deleteVertex,
  finishDraft,
  handleIndices,
  hitFeature,
  hitSegment,
  hitVertex,
  insertVertex,
  isPolygonKind,
  minPoints,
  moveVertex,
  normalizeFeature,
  updateFeature,
  validate,
  validateFeature,
  type EditFeature,
  type GroundKind,
  type LatLon,
  type Project,
} from "@/lib/groundEdit";
import FilterChips from "@/components/ui/FilterChips.vue";

const props = defineProps<{
  messages: Record<string, unknown>;
  icao: string;
  fir: string | null;
  /** 机场参考点：没有要素时视野落在这里。 */
  lat: number;
  lon: number;
  /** 关闭后回哪儿。 */
  backHref: string;
}>();
const t = createTranslator(props.messages);

/** 命中容差，像素。 */
const TOLERANCE = 8;
/** 列表最多渲染多少行 —— 大场上千条，全渲染是几千个节点。截断会写出来。 */
const LIST_LIMIT = 200;
const HIGHLIGHT = "#ffd166";
/** 提示里 Ground 仓库的目录名。机场没有 FIR 时留一个占位，让人自己填。 */
const firLabel = props.fir ?? "<FIR>";

const sourceUrl = `/api/v1/aip/airports/${encodeURIComponent(props.icao)}/ground/source`;
const saveUrl = `/api/v1/aip/airports/${encodeURIComponent(props.icao)}/ground`;
const exportHref = `/api/v1/aip/airports/${encodeURIComponent(props.icao)}/ground.json`;

/* ---------------------------------------------------------------------------
   状态
--------------------------------------------------------------------------- */

const loadState = ref<"loading" | "ready" | "error">("loading");
const loadError = ref("");
/** 读回来时就是空的（404）—— 给一句「从这里开始画」。 */
const startedEmpty = ref(false);

let history = new EditHistory([]);
/** 此刻画在图上的那一份。拖顶点时是预览，松手才进撤销栈。 */
const features = shallowRef<EditFeature[]>([]);
/** `history` 不是响应式的；每次动它就加一，让依赖它的 computed 重算。 */
const version = ref(0);
function tracked<T>(read: () => T) {
  return computed(() => {
    void version.value;
    return read();
  });
}
const dirty = tracked(() => history.dirty);
const canUndo = tracked(() => history.canUndo);
const canRedo = tracked(() => history.canRedo);

const selected = ref<number | null>(null);
const mode = ref<"select" | "draw">("select");
const drawKind = ref<GroundKind>("taxiway");
const draft = shallowRef<LatLon[]>([]);
const cursor = shallowRef<LatLon | null>(null);

const saving = ref(false);
const saveError = ref("");
const hint = ref("");
const savedCount = ref<number | null>(null);
const confirmEmpty = ref(false);
const confirmDiscard = ref(false);
let leaving = false;

/* OSM 导入：选文件 → dry_run 预览 → 确认 → overwrite=1 写入 → 重新 load()。 */
const osmInput = ref<HTMLInputElement | null>(null);
const osmPreview = shallowRef<GroundOsmPreview | null>(null);
const osmFile = ref("");
let osmXml = "";
const confirmOsm = ref(false);
const importing = ref(false);
const importedCount = ref<number | null>(null);

const issues = computed(() => validate(features.value));
const issuesByFeature = computed(() => {
  const out = new Map<number, string[]>();
  for (const i of issues.value) {
    out.set(i.feature, [...(out.get(i.feature) ?? []), i.code]);
  }
  return out;
});

const current = computed(() =>
  selected.value === null ? null : (features.value[selected.value] ?? null),
);

function kindLabel(kind: string): string {
  return t("kind." + kind);
}

/** 所有状态变化都走这里：记一步撤销，换上新的一份。 */
function apply(next: EditFeature[]) {
  history.commit(next);
  features.value = history.current;
  version.value++;
  savedCount.value = null;
  importedCount.value = null;
  saveError.value = "";
}

function clampSelection() {
  if (selected.value !== null && selected.value >= features.value.length) {
    selected.value = null;
  }
}

function undo() {
  if (!history.canUndo) return;
  features.value = history.undo();
  version.value++;
  clampSelection();
}

function redo() {
  if (!history.canRedo) return;
  features.value = history.redo();
  version.value++;
  clampSelection();
}

/* ---------------------------------------------------------------------------
   Leaflet
--------------------------------------------------------------------------- */

const host = ref<HTMLDivElement | null>(null);
const map = shallowRef<L.Map | null>(null);
const tiles = shallowRef<L.TileLayer | null>(null);
let renderer: L.Canvas | null = null;
let featureGroup: L.LayerGroup | null = null;
let selectionGroup: L.LayerGroup | null = null;
let draftGroup: L.LayerGroup | null = null;
/** 和 `drawn` 按下标一一对应。重画时比对引用，只换变了的那几条。 */
let layers: L.Layer[] = [];
let drawn: EditFeature[] = [];

const project: Project = (p) => {
  const pt = map.value!.latLngToContainerPoint(p as L.LatLngExpression);
  return { x: pt.x, y: pt.y };
};

function styleOf(kind: string) {
  return FEATURE_STYLE[kind] ?? FEATURE_FALLBACK;
}

/**
 * 每个画序一层 pane，各带一块 canvas。
 *
 * `layers` 和 `features` 按下标对应，改一条只换那一层 —— 同一块 canvas 上后加的会压在
 * 上面，画序就乱了。分 pane 后先后由 pane 的 z-index 定，和加的先后无关。pane 在
 * overlayPane（400）之下，选中和草稿始终在要素上面。
 */
const renderers = new Map<number, { pane: string; canvas: L.Canvas }>();

function paneFor(kind: string): { pane: string; canvas: L.Canvas } {
  const rank = Math.floor(drawRank(kind));
  let r = renderers.get(rank);
  if (!r) {
    const pane = `ground-${rank}`;
    const m = map.value!;
    if (!m.getPane(pane)) m.createPane(pane).style.zIndex = String(300 + rank);
    r = { pane, canvas: L.canvas({ padding: 0.5, pane }) };
    renderers.set(rank, r);
  }
  return r;
}

function layerFor(f: EditFeature): L.Layer {
  const st = styleOf(f.kind);
  const { pane, canvas } = paneFor(f.kind);
  const common = { color: st.color, renderer: canvas, interactive: false };
  const pts = f.points as L.LatLngExpression[];
  // 滑行道标注只画字（和机场图一样）；还没填代号时画一个「?」，免得看不见。
  if (LABEL_KINDS.has(f.kind) && f.points.length >= 1) {
    const text = f.name?.trim() || "?";
    return L.marker(pts[0], {
      pane,
      interactive: false,
      keyboard: false,
      icon: L.divIcon({
        className: "can-map-icon",
        html:
          `<div class="can-fix" style="--can-fix-color:${st.color}">` +
          `<span class="can-fix__name can-fix__name--always">${escapeHtml(text)}</span></div>`,
        iconSize: [0, 0],
        iconAnchor: [0, 0],
      }),
    });
  }
  if (f.points.length === 1) {
    return L.circleMarker(pts[0], {
      ...common,
      radius: 3.5,
      weight: 1,
      fillOpacity: 0.85,
    });
  }
  if (isPolygonKind(f.kind) && f.points.length >= 3) {
    return L.polygon(pts, {
      ...common,
      weight: st.weight,
      opacity: 0.85,
      fillOpacity: st.fillOpacity ?? 0.08,
    });
  }
  return L.polyline(pts, { ...common, weight: st.weight, opacity: 0.85 });
}

function syncFeatures() {
  const g = featureGroup;
  if (!g) return;
  const next = features.value;
  if (next.length !== drawn.length) {
    g.clearLayers();
    layers = next.map((f) => layerFor(f).addTo(g));
  } else {
    for (let i = 0; i < next.length; i++) {
      if (next[i] === drawn[i]) continue;
      g.removeLayer(layers[i]);
      layers[i] = layerFor(next[i]).addTo(g);
    }
  }
  drawn = next;
}

function drawSelection() {
  const g = selectionGroup;
  if (!g) return;
  g.clearLayers();
  const f = current.value;
  if (!f) return;
  const pts = f.points as L.LatLngExpression[];
  if (f.points.length === 1) {
    L.circleMarker(pts[0], {
      renderer: renderer!,
      interactive: false,
      radius: 9,
      color: HIGHLIGHT,
      weight: 2,
      fill: false,
    }).addTo(g);
  } else {
    const opts = {
      renderer: renderer!,
      interactive: false,
      color: HIGHLIGHT,
      weight: 5,
      opacity: 0.55,
    };
    (isPolygonKind(f.kind) && f.points.length >= 3
      ? L.polygon(pts, { ...opts, fillOpacity: 0.12 })
      : L.polyline(pts, opts)
    ).addTo(g);
  }
  for (const vi of handleIndices(f)) {
    L.circleMarker(pts[vi], {
      renderer: renderer!,
      interactive: false,
      radius: 4,
      color: "#1f2937",
      weight: 1.5,
      fillColor: "#ffffff",
      fillOpacity: 1,
    }).addTo(g);
  }
}

function drawDraft() {
  const g = draftGroup;
  if (!g) return;
  g.clearLayers();
  if (mode.value !== "draw") return;
  const pts = draft.value as L.LatLngExpression[];
  const color = styleOf(drawKind.value).color;
  const withCursor = cursor.value
    ? [...pts, cursor.value as L.LatLngExpression]
    : pts;
  if (withCursor.length >= 2) {
    L.polyline(withCursor, {
      renderer: renderer!,
      interactive: false,
      color,
      weight: 2,
      dashArray: "5 5",
    }).addTo(g);
  }
  for (const p of pts) {
    L.circleMarker(p, {
      renderer: renderer!,
      interactive: false,
      radius: 3.5,
      color,
      weight: 1.5,
      fillColor: "#ffffff",
      fillOpacity: 1,
    }).addTo(g);
  }
}

let basemap = loadBasemap();

function applyTiles(theme: "dark" | "light") {
  const m = map.value;
  if (!m) return;
  tiles.value?.remove();
  const source = tileSource(basemap, theme);
  tiles.value = L.tileLayer(source.url, {
    attribution: source.attribution,
    maxZoom: 21,
    maxNativeZoom: source.maxNativeZoom,
    pane: "tilePane",
  }).addTo(m);
}

function fitAll() {
  const m = map.value;
  if (!m) return;
  const pts = features.value.flatMap((f) => f.points) as L.LatLngExpression[];
  if (pts.length) m.fitBounds(L.latLngBounds(pts).pad(0.1));
  else m.setView([props.lat, props.lon], 15);
}

function zoomTo(fi: number) {
  const m = map.value;
  const f = features.value[fi];
  if (!m || !f || !f.points.length) return;
  if (f.points.length === 1) {
    m.setView(f.points[0] as L.LatLngExpression, Math.max(m.getZoom(), 18));
  } else {
    m.fitBounds(L.latLngBounds(f.points as L.LatLngExpression[]).pad(0.4), {
      maxZoom: 19,
    });
  }
}

function select(fi: number | null, zoom = false) {
  selected.value = fi;
  if (zoom && fi !== null) zoomTo(fi);
}

/* ---------------------------------------------------------------------------
   鼠标
--------------------------------------------------------------------------- */

let drag: {
  fi: number;
  vi: number;
  base: EditFeature[];
  moved: boolean;
} | null = null;
/** 拖完顶点时浏览器还会补一个 click —— 吞掉它，否则松手处没有要素就会取消选中。 */
let swallowClick = false;

function onMouseDownCapture(e: MouseEvent) {
  swallowClick = false;
  const m = map.value;
  if (!m || e.button !== 0 || loadState.value !== "ready") return;
  if (mode.value !== "select" || selected.value === null) return;
  const fi = selected.value;
  const hit = hitVertex(
    features.value,
    project,
    m.mouseEventToContainerPoint(e),
    TOLERANCE,
    [fi],
  );
  if (!hit) return;
  e.stopPropagation();
  e.preventDefault();
  swallowClick = true;

  if (e.altKey) {
    const next = deleteVertex(features.value, fi, hit.vertex);
    if (next) apply(next);
    else {
      const f = features.value[fi];
      hint.value = t("vertexMin", {
        kind: kindLabel(f.kind),
        n: minPoints(f.kind),
      });
    }
    return;
  }

  drag = { fi, vi: hit.vertex, base: features.value, moved: false };
  document.addEventListener("mousemove", onDragMove);
  document.addEventListener("mouseup", onDragEnd);
}

function onDragMove(e: MouseEvent) {
  const m = map.value;
  if (!drag || !m) return;
  const ll = m.mouseEventToLatLng(e);
  features.value = moveVertex(drag.base, drag.fi, drag.vi, [ll.lat, ll.lng]);
  drag.moved = true;
}

function onDragEnd() {
  document.removeEventListener("mousemove", onDragMove);
  document.removeEventListener("mouseup", onDragEnd);
  if (!drag) return;
  const moved = drag.moved;
  drag = null;
  if (moved) apply(features.value);
  else features.value = history.current;
}

function onMapClick(e: L.LeafletMouseEvent) {
  if (swallowClick) {
    swallowClick = false;
    return;
  }
  if (loadState.value !== "ready") return;
  hint.value = "";
  if (mode.value === "select") {
    select(hitFeature(features.value, project, e.containerPoint, TOLERANCE));
    return;
  }
  // 绘制：双击会先来两个 click。单点要素第一下就画完了，第二下（detail ≥ 2）不再画一个；
  // 其余类别和上一点几乎重合的那一下不加。
  if (POINT_KINDS.has(drawKind.value) && e.originalEvent.detail > 1) return;
  const last = draft.value[draft.value.length - 1];
  if (last) {
    const p = project(last);
    if (Math.hypot(p.x - e.containerPoint.x, p.y - e.containerPoint.y) < 4)
      return;
  }
  draft.value = [...draft.value, [e.latlng.lat, e.latlng.lng]];
  if (POINT_KINDS.has(drawKind.value)) finishDrawing();
}

function onMapDblClick(e: L.LeafletMouseEvent) {
  if (loadState.value !== "ready") return;
  if (mode.value === "draw") {
    finishDrawing();
    return;
  }
  const at = e.containerPoint;
  const hit =
    (selected.value !== null
      ? hitSegment(features.value, project, at, TOLERANCE, [selected.value])
      : null) ?? hitSegment(features.value, project, at, TOLERANCE);
  if (!hit) return;
  const f = features.value[hit.feature];
  const a = f.points[hit.segment];
  const b = f.points[hit.segment + 1];
  const r = insertVertex(features.value, hit.feature, hit.segment, [
    a[0] + (b[0] - a[0]) * hit.t,
    a[1] + (b[1] - a[1]) * hit.t,
  ]);
  if (!r) return;
  apply(r.features);
  selected.value = hit.feature;
}

let hoverFrame = 0;
function onMapMouseMove(e: L.LeafletMouseEvent) {
  if (mode.value === "draw") {
    cursor.value = [e.latlng.lat, e.latlng.lng];
    return;
  }
  if (drag || hoverFrame) return;
  const at = e.containerPoint;
  hoverFrame = requestAnimationFrame(() => {
    hoverFrame = 0;
    const el = host.value;
    if (!el || mode.value !== "select") return;
    const onVertex =
      selected.value !== null &&
      hitVertex(features.value, project, at, TOLERANCE, [selected.value]);
    el.style.cursor = onVertex
      ? "move"
      : hitFeature(features.value, project, at, TOLERANCE) !== null
        ? "pointer"
        : "";
  });
}

function onMapMouseOut() {
  cursor.value = null;
}

/* ---------------------------------------------------------------------------
   绘制
--------------------------------------------------------------------------- */

function finishDrawing() {
  if (!draft.value.length) return;
  const f = finishDraft(drawKind.value, draft.value);
  if (!f) {
    hint.value = t("draftTooShort", {
      kind: kindLabel(drawKind.value),
      n: minPoints(drawKind.value),
    });
    return;
  }
  const r = addFeature(features.value, f);
  apply(r.features);
  selected.value = r.index;
  draft.value = [];
  hint.value = "";
}

function cancelDrawing() {
  draft.value = [];
  hint.value = "";
}

function setMode(next: "select" | "draw") {
  mode.value = next;
  draft.value = [];
  cursor.value = null;
  hint.value = "";
  if (host.value) host.value.style.cursor = next === "draw" ? "crosshair" : "";
}

/* ---------------------------------------------------------------------------
   键盘
--------------------------------------------------------------------------- */

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return (
    el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)
  );
}

function onKeyDown(e: KeyboardEvent) {
  if (
    loadState.value !== "ready" ||
    confirmEmpty.value ||
    confirmDiscard.value ||
    confirmOsm.value
  )
    return;
  if (isTyping(e.target)) return;
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();
  if (mod && key === "z") {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
    return;
  }
  if (mod && key === "y") {
    e.preventDefault();
    redo();
    return;
  }
  if (mod || e.altKey) return;

  if (mode.value === "draw" && draft.value.length) {
    if (e.key === "Enter") {
      e.preventDefault();
      finishDrawing();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelDrawing();
    } else if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      draft.value = draft.value.slice(0, -1);
    }
    return;
  }

  if (e.key === "Delete" || e.key === "Backspace") {
    if (selected.value === null) return;
    e.preventDefault();
    removeSelected();
  } else if (e.key === "Escape") {
    if (mode.value === "draw") setMode("select");
    else selected.value = null;
  }
}

/* ---------------------------------------------------------------------------
   侧栏：选中要素的属性
--------------------------------------------------------------------------- */

const widthError = ref("");

function removeSelected() {
  if (selected.value === null) return;
  apply(deleteFeature(features.value, selected.value));
  selected.value = null;
}

function onKindChange(e: Event) {
  if (selected.value === null) return;
  const next = updateFeature(features.value, selected.value, {
    kind: (e.target as HTMLSelectElement).value,
  });
  if (next) apply(next);
}

function onNameChange(e: Event) {
  if (selected.value === null) return;
  const next = updateFeature(features.value, selected.value, {
    name: (e.target as HTMLInputElement).value,
  });
  if (next) apply(next);
}

/**
 * 宽度框。type=number 的框里是「45e」这种不成数的字时 `value` 是空串，和清空一样 ——
 * 所以先看 `validity.badInput`：不成数就报错、不改，不能当成「不填宽度」存成 null。
 *
 * 不收的值留在框里，错误说的就是框里的那个字；框里的字一动、或框按库里的值重建
 * （换选中、撤销、别的改动），错误就撤掉。所以框绑的是 `defaultValue` 不是 `value`：
 * Vue 每次重画都会把 `value` 写回去，报错那一下重画就把框里的字换回了库里的值；
 * `defaultValue` 只在框新建时生效，框靠 `:key` 跟着库里的值重建。
 */
function onWidthChange(e: Event) {
  if (selected.value === null) return;
  const input = e.target as HTMLInputElement;
  const next = input.validity.badInput
    ? null
    : updateFeature(features.value, selected.value, {
        width_m: input.value.trim() === "" ? null : input.valueAsNumber,
      });
  if (!next) {
    widthError.value = t("widthInvalid");
    return;
  }
  widthError.value = "";
  apply(next);
}

function onWidthInput() {
  widthError.value = "";
}

watch([selected, version], () => {
  widthError.value = "";
});

/* ---------------------------------------------------------------------------
   侧栏：要素列表
--------------------------------------------------------------------------- */

const listKind = ref("");
const listQuery = ref("");

const kindChips = computed(() => {
  const n: Record<string, number> = {};
  for (const f of features.value) n[f.kind] = (n[f.kind] ?? 0) + 1;
  return GROUND_KINDS.filter((k) => n[k]).map((k) => ({
    value: k,
    label: kindLabel(k),
    count: n[k],
    color: styleOf(k).color,
  }));
});

const listRows = computed(() => {
  const q = listQuery.value.trim().toLowerCase();
  const out: { index: number; f: EditFeature }[] = [];
  features.value.forEach((f, index) => {
    if (listKind.value && f.kind !== listKind.value) return;
    if (q && !(f.name ?? "").toLowerCase().includes(q)) return;
    out.push({ index, f });
  });
  return out;
});

/* ---------------------------------------------------------------------------
   保存 / 导出 / 关闭
--------------------------------------------------------------------------- */

async function save(confirmed = false) {
  saveError.value = "";
  savedCount.value = null;
  importedCount.value = null;
  if (issues.value.length) {
    saveError.value = t("saveInvalid", { n: issues.value.length });
    select(issues.value[0].feature, true);
    return;
  }
  if (!features.value.length && !confirmed) {
    confirmEmpty.value = true;
    return;
  }
  confirmEmpty.value = false;
  const snapshot = features.value;
  saving.value = true;
  const r = await api<{ icao: string; count: number }>(saveUrl, {
    method: "PUT",
    body: JSON.stringify({ features: snapshot }),
  });
  saving.value = false;
  if (!r.ok) {
    saveError.value = t("saveFailed", { message: r.message });
    return;
  }
  history.markSaved(snapshot);
  version.value++;
  savedCount.value = r.data?.count ?? snapshot.length;
}

function pickOsm() {
  osmInput.value?.click();
}

async function onOsmPicked(e: Event) {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  // 清掉，否则再选同一个文件不触发 change。
  input.value = "";
  if (!file) return;
  saveError.value = "";
  savedCount.value = null;
  importedCount.value = null;
  importing.value = true;
  let xml: string;
  try {
    xml = await file.text();
  } catch {
    importing.value = false;
    saveError.value = t("osmReadFailed", { name: file.name });
    return;
  }
  const r = await previewGroundOsm(props.icao, xml);
  importing.value = false;
  if (!r.ok) {
    saveError.value = t("osmFailed", { message: r.message });
    return;
  }
  osmXml = xml;
  osmFile.value = file.name;
  osmPreview.value = r.data;
  confirmOsm.value = true;
}

const osmKinds = computed(() =>
  Object.entries(osmPreview.value?.stats?.kinds ?? {}).sort(
    (a, b) => b[1] - a[1],
  ),
);
const osmSkipped = computed(() =>
  Object.entries(osmPreview.value?.stats?.skipped ?? {}).sort(
    (a, b) => b[1] - a[1],
  ),
);

function cancelOsm() {
  confirmOsm.value = false;
  osmPreview.value = null;
  osmXml = "";
}

async function confirmImportOsm() {
  importing.value = true;
  const r = await importGroundOsm(props.icao, osmXml, true);
  importing.value = false;
  if (!r.ok) {
    confirmOsm.value = false;
    saveError.value = t("osmFailed", { message: r.message });
    return;
  }
  const count = r.data?.count ?? osmPreview.value?.features?.length ?? 0;
  cancelOsm();
  await load();
  importedCount.value = count;
}

function leave() {
  leaving = true;
  window.location.href = props.backHref;
}

function close() {
  if (dirty.value) confirmDiscard.value = true;
  else leave();
}

function onBeforeUnload(e: BeforeUnloadEvent) {
  if (!dirty.value || leaving) return;
  e.preventDefault();
  e.returnValue = "";
}

/* ---------------------------------------------------------------------------
   读取
--------------------------------------------------------------------------- */

async function load() {
  loadState.value = "loading";
  loadError.value = "";
  const r = await api<{ icao: string; features: Partial<EditFeature>[] }>(
    sourceUrl,
  );
  // 404 是「这个机场还没有地面要素」，不是失败 —— 从空白开始画。别的失败不给编辑：
  // 没读到库里有什么就保存，等于用一份空的把它整个盖掉。
  if (!r.ok && r.status !== 404) {
    loadError.value = r.message;
    loadState.value = "error";
    return;
  }
  const list = r.ok ? (r.data?.features ?? []).map(normalizeFeature) : [];
  history = new EditHistory(list);
  features.value = list;
  selected.value = null;
  startedEmpty.value = list.length === 0;
  version.value++;
  loadState.value = "ready";
  fitAll();
}

/* ---------------------------------------------------------------------------
   生命周期
--------------------------------------------------------------------------- */

let stopTheme: (() => void) | null = null;

onMounted(() => {
  if (!host.value) return;
  const m = L.map(host.value, {
    zoomControl: true,
    maxZoom: 21,
    doubleClickZoom: false,
    boxZoom: false,
    keyboard: false,
  });
  map.value = m;
  renderer = L.canvas({ padding: 0.5 });
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
  featureGroup = L.layerGroup().addTo(m);
  selectionGroup = L.layerGroup().addTo(m);
  draftGroup = L.layerGroup().addTo(m);
  m.setView([props.lat, props.lon], 15);

  host.value.addEventListener("mousedown", onMouseDownCapture, true);
  m.on("click", onMapClick);
  m.on("dblclick", onMapDblClick);
  m.on("mousemove", onMapMouseMove);
  m.on("mouseout", onMapMouseOut);
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("beforeunload", onBeforeUnload);

  stopTheme = watchTheme((theme) => applyTiles(theme));
  void load();
});

onBeforeUnmount(() => {
  stopTheme?.();
  host.value?.removeEventListener("mousedown", onMouseDownCapture, true);
  document.removeEventListener("mousemove", onDragMove);
  document.removeEventListener("mouseup", onDragEnd);
  window.removeEventListener("keydown", onKeyDown);
  window.removeEventListener("beforeunload", onBeforeUnload);
  if (hoverFrame) cancelAnimationFrame(hoverFrame);
  map.value?.remove();
  map.value = null;
});

watch(features, () => {
  syncFeatures();
  drawSelection();
});
watch(selected, drawSelection);
watch([draft, cursor, drawKind, mode], drawDraft);
</script>

<template>
  <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_19rem] lg:items-start">
    <!-- `isolate`：Leaflet 的图层和控件带 400–1000 的 z-index。 -->
    <div class="card isolate overflow-hidden">
      <div
        class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-subtle px-3 py-2.5"
        role="toolbar"
        :aria-label="t('mode')"
      >
        <div
          class="flex items-center gap-1.5"
          role="group"
          :aria-label="t('mode')"
        >
          <button
            type="button"
            class="chip"
            :aria-pressed="mode === 'select'"
            @click="setMode('select')"
          >
            {{ t("modeSelect") }}
          </button>
          <button
            type="button"
            class="chip"
            :aria-pressed="mode === 'draw'"
            :disabled="loadState !== 'ready'"
            @click="setMode('draw')"
          >
            <Icon name="pencilSquare" class="size-3.5" />
            {{ t("modeDraw") }}
          </button>
        </div>

        <label
          v-if="mode === 'draw'"
          class="flex items-center gap-2 text-xs text-muted"
        >
          {{ t("drawKind") }}
          <select
            v-model="drawKind"
            class="input h-8 w-auto py-0 text-sm"
            @change="cancelDrawing"
          >
            <option v-for="k in GROUND_KINDS" :key="k" :value="k">
              {{ kindLabel(k) }}
            </option>
          </select>
        </label>

        <span
          class="hidden h-4 border-l border-subtle sm:block"
          aria-hidden="true"
        />

        <div class="flex items-center gap-1.5">
          <button
            type="button"
            class="btn btn-ghost h-8 px-2.5 text-xs"
            :disabled="!canUndo"
            :title="`${t('undo')} (⌘Z / Ctrl+Z)`"
            @click="undo"
          >
            {{ t("undo") }}
          </button>
          <button
            type="button"
            class="btn btn-ghost h-8 px-2.5 text-xs"
            :disabled="!canRedo"
            :title="`${t('redo')} (⇧⌘Z / Shift+Ctrl+Z)`"
            @click="redo"
          >
            {{ t("redo") }}
          </button>
        </div>

        <div class="ml-auto flex flex-wrap items-center gap-2">
          <span
            class="text-xs"
            :class="dirty ? 'text-warning' : 'text-faint'"
            role="status"
          >
            {{ dirty ? t("unsaved") : t("allSaved") }}
          </span>
          <input
            ref="osmInput"
            type="file"
            accept=".osm,.xml"
            class="hidden"
            @change="onOsmPicked"
          />
          <button
            type="button"
            class="btn btn-secondary h-8 px-2.5 text-xs"
            :disabled="loadState !== 'ready' || saving || importing"
            :title="t('osmImportTitle')"
            @click="pickOsm"
          >
            <Spinner v-if="importing" size="sm" />
            <Icon v-else name="documentText" class="size-3.5" />
            {{ importing ? t("osmImporting") : t("osmImport") }}
          </button>
          <a
            :href="exportHref"
            class="btn btn-secondary h-8 px-2.5 text-xs"
            download
            :title="dirty ? t('exportDirty') : undefined"
          >
            <Icon name="arrowDownTray" class="size-3.5" />
            {{ t("export") }}
          </a>
          <button
            type="button"
            class="btn btn-secondary h-8 px-2.5 text-xs"
            @click="close"
          >
            {{ t("close") }}
          </button>
          <button
            type="button"
            class="btn btn-primary h-8 px-3 text-xs"
            :disabled="loadState !== 'ready' || saving || !dirty"
            @click="save()"
          >
            {{ saving ? t("saving") : t("save") }}
          </button>
        </div>
      </div>

      <!-- 图的容器始终在 DOM 里：Leaflet 绑在这个节点上。 -->
      <div class="relative">
        <div
          ref="host"
          class="h-[clamp(22rem,65svh,34rem)] w-full sm:h-[clamp(28rem,72vh,48rem)]"
          role="application"
          :aria-label="t('mapLabel', { icao })"
        />
        <div
          v-if="loadState === 'loading'"
          class="map-panel absolute left-3 top-3 z-[1000] flex items-center gap-2 px-2.5 py-2 text-xs text-muted"
        >
          <Spinner size="sm" />
          {{ t("loading") }}
        </div>
      </div>

      <div
        class="flex flex-col gap-1.5 border-t border-subtle px-3 py-2.5 text-xs text-muted"
      >
        <p>
          {{
            mode === "draw"
              ? POINT_KINDS.has(drawKind)
                ? t("hintDrawPoint", { kind: kindLabel(drawKind) })
                : t("hintDraw")
              : t("hintSelect")
          }}
        </p>
        <p v-if="hint" class="text-warning" role="status">{{ hint }}</p>
        <p v-if="dirty" class="text-faint">{{ t("exportDirty") }}</p>
      </div>
    </div>

    <aside class="flex flex-col gap-4">
      <AlertBox v-if="loadState === 'error'" variant="danger">
        <div class="flex flex-wrap items-center gap-3">
          <span class="min-w-0 flex-1">{{
            t("loadError", { message: loadError })
          }}</span>
          <button
            type="button"
            class="btn btn-secondary h-8 px-2.5 text-xs"
            @click="load"
          >
            {{ t("retry") }}
          </button>
        </div>
      </AlertBox>

      <AlertBox
        v-if="loadState === 'ready' && startedEmpty && !features.length"
        variant="info"
      >
        {{ t("empty") }}
      </AlertBox>

      <AlertBox
        v-if="saveError"
        variant="danger"
        dismissible
        @dismiss="saveError = ''"
      >
        {{ saveError }}
      </AlertBox>

      <!-- 保存成功的提示一直带着「导出并提交」：只进了资料库的改动，下一次扇区地面导入
           会把它盖掉。 -->
      <AlertBox
        v-if="savedCount !== null"
        variant="warning"
        :title="t('savedTitle', { n: savedCount })"
        dismissible
        @dismiss="savedCount = null"
      >
        {{ t("savedBody", { icao, fir: firLabel }) }}
      </AlertBox>

      <AlertBox
        v-if="importedCount !== null"
        variant="warning"
        :title="t('osmImportedTitle', { n: importedCount })"
        dismissible
        @dismiss="importedCount = null"
      >
        {{ t("savedBody", { icao, fir: firLabel }) }}
      </AlertBox>

      <section class="card p-4">
        <h2 class="text-title-3 mb-3 text-ink">{{ t("selected") }}</h2>
        <p v-if="!current" class="text-sm text-faint">
          {{ t("noSelection") }}
        </p>
        <div v-else class="space-y-3">
          <div>
            <label class="mb-1 block text-xs text-muted" for="ge-kind">{{
              t("kindLabel")
            }}</label>
            <select
              id="ge-kind"
              class="input w-full"
              :value="current.kind"
              @change="onKindChange"
            >
              <option
                v-for="k in GROUND_KINDS"
                :key="k"
                :value="k"
                :disabled="minPoints(k) > current.points.length"
              >
                {{ kindLabel(k) }}
              </option>
            </select>
          </div>
          <div>
            <label class="mb-1 block text-xs text-muted" for="ge-name">{{
              t("name")
            }}</label>
            <input
              id="ge-name"
              :key="`name-${selected}-${version}`"
              class="input w-full font-mono"
              :value="current.name ?? ''"
              :placeholder="t('namePlaceholder')"
              autocomplete="off"
              @change="onNameChange"
            />
          </div>
          <div>
            <label class="mb-1 block text-xs text-muted" for="ge-width">{{
              t("width")
            }}</label>
            <input
              id="ge-width"
              :key="`width-${selected}-${version}`"
              class="input w-full"
              type="number"
              min="0"
              step="any"
              inputmode="decimal"
              :defaultValue="current.width_m ?? ''"
              :placeholder="t('widthPlaceholder')"
              :aria-invalid="widthError ? 'true' : undefined"
              @input="onWidthInput"
              @change="onWidthChange"
            />
            <p v-if="widthError" class="mt-1 text-xs text-danger" role="alert">
              {{ widthError }}
            </p>
          </div>
          <p class="tnum text-xs text-faint">
            {{ t("points", { n: current.points.length }) }}
          </p>
          <ul
            v-if="selected !== null && issuesByFeature.get(selected)"
            class="text-xs text-danger"
          >
            <li v-for="code in issuesByFeature.get(selected)" :key="code">
              {{ t("issue." + code) }}
            </li>
          </ul>
          <div class="flex gap-2">
            <button
              type="button"
              class="btn btn-secondary h-8 px-2.5 text-xs"
              @click="selected !== null && zoomTo(selected)"
            >
              {{ t("zoomTo") }}
            </button>
            <button
              type="button"
              class="btn btn-danger ml-auto h-8 px-2.5 text-xs"
              @click="removeSelected"
            >
              {{ t("deleteFeature") }}
            </button>
          </div>
        </div>
      </section>

      <section class="card p-4">
        <h2 class="text-title-3 mb-1 text-ink">
          {{ t("list") }}
          <span class="tnum ml-1.5 font-normal text-faint">{{
            features.length
          }}</span>
        </h2>
        <p v-if="issues.length" class="mb-2 text-xs text-danger">
          {{ t("issues", { n: issues.length }) }}
        </p>
        <FilterChips
          v-model="listKind"
          class="mb-2 mt-2"
          :chips="kindChips"
          :label="t('listFilter')"
          :all-label="t('listAll')"
          :all-count="features.length"
        />
        <input
          v-model="listQuery"
          class="input mb-2 w-full text-sm"
          type="search"
          :placeholder="t('listSearch')"
          :aria-label="t('listSearch')"
          autocomplete="off"
        />
        <p v-if="!listRows.length" class="text-xs text-faint">
          {{ t("listEmpty") }}
        </p>
        <ul v-else class="scroll-shadow-y -mx-1 max-h-[26rem] overflow-y-auto">
          <li v-for="row in listRows.slice(0, LIST_LIMIT)" :key="row.index">
            <button
              type="button"
              class="flex w-full items-center gap-2 rounded-control px-1.5 py-1 text-left text-sm hover:bg-surface-sunken"
              :class="
                row.index === selected
                  ? 'bg-surface-sunken text-ink'
                  : 'text-muted'
              "
              :aria-current="row.index === selected ? 'true' : undefined"
              @click="select(row.index, true)"
            >
              <span
                class="size-2 flex-none rounded-full"
                :style="{ backgroundColor: styleOf(row.f.kind).color }"
                aria-hidden="true"
              />
              <span
                class="min-w-0 flex-1 truncate"
                :class="row.f.name ? 'font-mono' : 'text-faint'"
              >
                {{ row.f.name ?? t("unnamed") }}
              </span>
              <span
                v-if="issuesByFeature.get(row.index)"
                class="badge badge-danger"
              >
                {{ t("issue." + validateFeature(row.f)[0]) }}
              </span>
              <span class="tnum flex-none text-xs text-faint">{{
                kindLabel(row.f.kind)
              }}</span>
            </button>
          </li>
        </ul>
        <p v-if="listRows.length > LIST_LIMIT" class="mt-2 text-xs text-faint">
          {{
            t("listTruncated", {
              shown: LIST_LIMIT,
              more: listRows.length - LIST_LIMIT,
            })
          }}
        </p>
      </section>
    </aside>

    <Dialog
      :open="confirmEmpty"
      :title="t('confirmEmptyTitle')"
      :description="t('confirmEmptyBody', { icao })"
      :dismissible="!saving"
      size="sm"
      @update:open="(v: boolean) => (confirmEmpty = v)"
    >
      <template #footer>
        <button
          type="button"
          class="btn btn-secondary"
          :disabled="saving"
          @click="confirmEmpty = false"
        >
          {{ t("cancel") }}
        </button>
        <button
          type="button"
          class="btn btn-danger"
          :disabled="saving"
          @click="save(true)"
        >
          {{ saving ? t("saving") : t("confirmEmpty") }}
        </button>
      </template>
    </Dialog>

    <Dialog
      :open="confirmOsm"
      :title="t('osmConfirmTitle', { icao })"
      :description="t('osmConfirmFile', { name: osmFile })"
      :dismissible="!importing"
      size="md"
      @update:open="(v: boolean) => (v ? (confirmOsm = true) : cancelOsm())"
    >
      <div v-if="osmPreview" class="flex flex-col gap-3 text-sm">
        <p>
          {{
            t("osmConfirmCount", {
              n: osmPreview.features?.length ?? 0,
              named: osmPreview.stats?.named ?? 0,
            })
          }}
        </p>
        <ul
          v-if="osmKinds.length"
          class="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3"
        >
          <li
            v-for="[kind, n] in osmKinds"
            :key="kind"
            class="flex justify-between gap-2"
          >
            <span class="text-muted">{{ kindLabel(kind) }}</span>
            <span class="tabular-nums">{{ n }}</span>
          </li>
        </ul>
        <div v-if="osmSkipped.length" class="text-xs">
          <p class="mb-1 text-muted">{{ t("osmSkipped") }}</p>
          <ul class="flex flex-wrap gap-x-3 gap-y-1">
            <li v-for="[key, n] in osmSkipped" :key="key">
              <code>{{ key }}</code>
              <span class="tabular-nums text-muted"> × {{ n }}</span>
            </li>
          </ul>
        </div>
        <p v-if="osmPreview.stats?.unmatched_labels" class="text-xs text-muted">
          {{ t("osmUnmatched", { n: osmPreview.stats.unmatched_labels }) }}
        </p>
        <AlertBox v-if="osmPreview.existing > 0" variant="warning">
          {{ t("osmOverwrite", { n: osmPreview.existing }) }}
        </AlertBox>
        <AlertBox v-if="dirty" variant="warning">
          {{ t("osmDiscardLocal") }}
        </AlertBox>
      </div>
      <template #footer>
        <button
          type="button"
          class="btn btn-secondary"
          :disabled="importing"
          @click="cancelOsm"
        >
          {{ t("cancel") }}
        </button>
        <button
          type="button"
          :class="
            osmPreview && (osmPreview.existing > 0 || dirty)
              ? 'btn btn-danger'
              : 'btn btn-primary'
          "
          :disabled="importing || !osmPreview?.features?.length"
          @click="confirmImportOsm"
        >
          {{
            importing
              ? t("osmImporting")
              : osmPreview && osmPreview.existing > 0
                ? t("osmConfirmOverwrite")
                : t("osmConfirm")
          }}
        </button>
      </template>
    </Dialog>

    <Dialog
      :open="confirmDiscard"
      :title="t('discardTitle')"
      :description="t('discardBody')"
      size="sm"
      @update:open="(v: boolean) => (confirmDiscard = v)"
    >
      <template #footer>
        <button
          type="button"
          class="btn btn-secondary"
          @click="confirmDiscard = false"
        >
          {{ t("keepEditing") }}
        </button>
        <button type="button" class="btn btn-danger" @click="leave">
          {{ t("discard") }}
        </button>
      </template>
    </Dialog>
  </div>
</template>
