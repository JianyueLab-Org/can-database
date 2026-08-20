<script setup lang="ts">
/**
 * 一个机场的地面：手工做的要素 + 从航图抠的线画。
 *
 * ## 两份数据，一张图
 *
 * `features` 是扇区包手工做的，分好类、带滑行道代号、米级，90 个机场；`lines` 是从汇编
 * 航图上抠的线画，没有语义也没有名字、5 到 20 米，100 个机场。并起来 121 个。
 *
 * 有手工那份就把它画在上面 —— 它知道自己是什么。线画留作底衬：那才是整张航图的画面，而
 * 手工那份只描了要紧的东西，两者叠起来才完整。
 *
 * ## 为什么这一页要有，而不是机场页上的一个勾
 *
 * 机场页那个勾是「顺便看一眼」；这一页是**拿来核对地面数据的**：图占满整屏、按类别分
 * 层、滑行道按代号列出来，点一个跳过去。核对的人要的是「W9 在哪、画对了没有」，那件事
 * 在一个塞在表格之间的小图里做不了。
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
import type { GroundLines } from "@/lib/canDb";
import {
  TILES,
  TILE_ATTRIBUTION,
  currentTheme,
  escapeHtml,
  watchTheme,
} from "@/lib/mapBase";

const props = defineProps<{
  messages: Record<string, unknown>;
  ground: GroundLines;
  center: [number, number];
}>();
const t = createTranslator(props.messages);

/** 各类要素的画法。跑道最显眼，机位最轻，其余居中。 */
const STYLE: Record<string, { color: string; weight: number }> = {
  runway: { color: "#e05252", weight: 3 },
  taxiway: { color: "#4c92c1", weight: 1.8 },
  apron: { color: "#5bbd8a", weight: 1.3 },
  terminal: { color: "#9a8ac1", weight: 1.3 },
  holding_position: { color: "#e0a252", weight: 2 },
  parking_position: { color: "#8a8a8a", weight: 1 },
  aerodrome: { color: "#8a8a8a", weight: 1 },
};

/** 类别按这个次序排，不按条数 —— 读的人按重要性找，不按多少找。 */
const ORDER = [
  "runway",
  "taxiway",
  "holding_position",
  "parking_position",
  "apron",
  "terminal",
  "aerodrome",
];

const host = ref<HTMLDivElement | null>(null);
const map = shallowRef<L.Map | null>(null);
const tiles = shallowRef<L.TileLayer | null>(null);
const featureLayer = shallowRef<L.LayerGroup | null>(null);
const lineLayer = shallowRef<L.LayerGroup | null>(null);
const highlight = shallowRef<L.Polyline | null>(null);

const kinds = computed(() => {
  const n: Record<string, number> = {};
  for (const f of props.ground.features) n[f.kind] = (n[f.kind] ?? 0) + 1;
  return ORDER.filter((k) => n[k]).map((k) => ({ kind: k, n: n[k] }));
});

const on = ref<Record<string, boolean>>({});
/** 机位默认关着：大场四百多个点铺满机坪，把滑行道压得看不见。 */
for (const k of ORDER) on.value[k] = k !== "parking_position";
const showLines = ref(props.ground.features.length === 0);

/** 有代号的滑行道，按代号排。核对的人是照着代号找的。 */
const namedTaxiways = computed(() => {
  const seen = new Map<string, [number, number][]>();
  for (const f of props.ground.features) {
    if (f.kind !== "taxiway" || !f.name) continue;
    // 同一条滑行道常被拆成好几段，代号相同 —— 收第一段的点用来定位就够。
    if (!seen.has(f.name)) seen.set(f.name, f.points);
  }
  return [...seen.entries()]
    .map(([name, points]) => ({ name, points }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
});

function drawFeatures() {
  const layer = featureLayer.value;
  if (!layer) return;
  layer.clearLayers();
  for (const f of props.ground.features) {
    if (!on.value[f.kind]) continue;
    const st = STYLE[f.kind] ?? { color: "#8a8a8a", weight: 1 };
    const tip =
      escapeHtml(f.name ?? "") + (f.name ? " · " : "") + escapeHtml(f.kind);
    // 单点的要素（等待位置、一部分机位）画成点：折线要两个点才画得出来。
    if (f.points.length < 2) {
      L.circleMarker(f.points[0] as L.LatLngExpression, {
        radius: 2.5,
        color: st.color,
        weight: 1,
        fillOpacity: 0.85,
      })
        .bindTooltip(tip, { direction: "top", offset: [0, -4] })
        .addTo(layer);
      continue;
    }
    L.polyline(f.points as L.LatLngExpression[], {
      color: st.color,
      weight: st.weight,
      opacity: 0.9,
    })
      .bindTooltip(tip, { sticky: true })
      .addTo(layer);
  }
}

function drawLines() {
  const layer = lineLayer.value;
  if (!layer) return;
  layer.clearLayers();
  if (!showLines.value) return;
  const theme = currentTheme();
  for (const l of props.ground.lines) {
    L.polyline(l.points as L.LatLngExpression[], {
      color: visible(l.rgb, theme),
      weight: Math.min(2, Math.max(0.5, l.widthM / 4)),
      opacity: 0.5,
      interactive: false,
    }).addTo(layer);
  }
}

/**
 * 把和底图撞在一起的那一档亮度拉开，色相不动。
 *
 * 航图的颜色是配着白纸选的：黑线在深色底图上、近白的线在浅色底图上都会整条消失。
 */
function visible(rgb: string, theme: "dark" | "light"): string {
  const m = /^#([0-9a-f]{6})$/i.exec(rgb);
  if (!m) return rgb;
  const n = parseInt(m[1], 16);
  let r = (n >> 16) & 255,
    g = (n >> 8) & 255,
    b = n & 255;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (lum < 0.02) return theme === "dark" ? "#8c8c8c" : rgb;
  const scale =
    theme === "dark" && lum < 0.3
      ? (0.55 + lum) / Math.max(lum, 0.02)
      : theme === "light" && lum > 0.85
        ? 0.65 / lum
        : 1;
  if (scale === 1) return rgb;
  const c = (v: number) => Math.min(255, Math.max(0, Math.round(v * scale)));
  r = c(r);
  g = c(g);
  b = c(b);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

function focus(points: [number, number][]) {
  const m = map.value;
  if (!m || !points.length) return;
  highlight.value?.remove();
  if (points.length >= 2) {
    highlight.value = L.polyline(points as L.LatLngExpression[], {
      color: "#ffd166",
      weight: 6,
      opacity: 0.7,
    }).addTo(m);
    m.fitBounds(L.latLngBounds(points as L.LatLngExpression[]).pad(0.5));
  } else {
    m.setView(points[0] as L.LatLngExpression, 17);
  }
}

function applyTiles(theme: "dark" | "light") {
  const m = map.value;
  if (!m) return;
  tiles.value?.remove();
  tiles.value = L.tileLayer(TILES[theme], {
    attribution: TILE_ATTRIBUTION,
    maxZoom: 19,
    pane: "tilePane",
  }).addTo(m);
}

let stopTheme: (() => void) | null = null;

onMounted(() => {
  if (!host.value) return;
  const m = L.map(host.value, { zoomControl: true, maxZoom: 19 });
  map.value = m;
  applyTiles(currentTheme());
  lineLayer.value = L.layerGroup().addTo(m);
  featureLayer.value = L.layerGroup().addTo(m);
  drawLines();
  drawFeatures();

  const pts: L.LatLngExpression[] = [];
  for (const f of props.ground.features)
    pts.push(...(f.points as L.LatLngExpression[]));
  if (pts.length < 2)
    for (const l of props.ground.lines)
      pts.push(...(l.points as L.LatLngExpression[]));
  if (pts.length >= 2) m.fitBounds(L.latLngBounds(pts).pad(0.05));
  else m.setView(props.center as L.LatLngExpression, 14);

  stopTheme = watchTheme((theme) => {
    applyTiles(theme);
    drawLines();
  });
});

onBeforeUnmount(() => {
  stopTheme?.();
  map.value?.remove();
  map.value = null;
});

watch(on, drawFeatures, { deep: true });
watch(showLines, drawLines);
</script>

<template>
  <div class="grid gap-4 lg:grid-cols-[1fr_16rem]">
    <div class="order-2 flex flex-col gap-3 lg:order-1">
      <div class="flex flex-wrap items-center gap-3 text-xs text-muted">
        <label
          v-for="k in kinds"
          :key="k.kind"
          class="flex items-center gap-1.5"
        >
          <input v-model="on[k.kind]" type="checkbox" class="accent-can" />
          <span
            class="inline-block h-2 w-2 rounded-full"
            :style="{ background: STYLE[k.kind]?.color ?? '#8a8a8a' }"
          />
          {{ t("kind." + k.kind) }}
          <span class="tnum text-faint">{{ k.n }}</span>
        </label>

        <label v-if="ground.lines.length" class="flex items-center gap-1.5">
          <input v-model="showLines" type="checkbox" class="accent-can" />
          {{ t("chartLines", { n: String(ground.lines.length) }) }}
        </label>
      </div>

      <div
        ref="host"
        class="h-[70vh] min-h-[26rem] w-full overflow-hidden rounded-xl border border-line"
      />

      <p class="text-xs text-faint">
        <template v-if="ground.features.length">{{ t("handNote") }}</template>
        <template v-if="ground.lines.length">
          {{ t("chartNote", { n: ground.accuracyM.toFixed(0) }) }}
          <template v-if="ground.runways === 0">
            · {{ t("unchecked") }}</template
          >
        </template>
      </p>
    </div>

    <!-- 滑行道代号：核对的人是照着代号找的，所以它是一列可点的清单而不是图上的标注。 -->
    <aside v-if="namedTaxiways.length" class="order-1 lg:order-2">
      <h2 class="mb-2 text-sm font-medium">
        {{ t("taxiwayList", { n: String(namedTaxiways.length) }) }}
      </h2>
      <div
        class="scroll-shadow-y max-h-[70vh] overflow-y-auto rounded-xl border border-line p-2"
      >
        <div class="flex flex-wrap gap-1.5">
          <button
            v-for="tw in namedTaxiways"
            :key="tw.name"
            type="button"
            class="rounded-md border border-line px-2 py-0.5 font-mono text-xs transition hover:border-can/50 hover:bg-can/10"
            @click="focus(tw.points)"
          >
            {{ tw.name }}
          </button>
        </div>
      </div>
    </aside>
  </div>
</template>
