<script setup lang="ts">
/**
 * 一个机场的图：跑道、机位、进离场程序。
 *
 * ## 跑道是真的线，不是一个点加一个航向
 *
 * `runway` 每条都带两个入口的坐标（`lat/lon` → `endLat/endLon`），所以跑道是照着数据
 * 画出来的线段，长度和朝向都是真的。用中心点加航向去反推会得到一条长度全靠猜的线，
 * 而这个控制台的用途正是校对这批数据 —— 画一条推出来的线等于把要校对的东西替掉了。
 *
 * ## 可疑的程序段画出来，但标记成可疑
 *
 * 扇区包里有一类代号是**每个机场各有一个的伪航路点**（`DER19` 是「19 号跑道离场端」，
 * `D101K` 是 DME 径向点）。can-db 的消歧规则是「先本机场 FIR、再离机场最近」，而 RJJJ
 * 一个 FIR 装着 128 个机场，于是日本境内有 56 条 SID 的首点落在几百甚至一千多公里外。
 *
 * 这里的处理是**画出来并标红**，不是悄悄跳过。理由很直接：这个站是拿来校对数据的，
 * 把可疑的一段藏起来，看图的人会以为数据是干净的。判据和 can-db 那份记录一致 ——
 * 离机场超过 `SUSPECT_KM` 的腿是可疑的。
 *
 * ## 地面要素按需取
 *
 * 地面要素只有一份：扇区包手工做的那份（OSM 派生，来自 Ground 仓库）。单独一条路由，
 * 勾上「地面」才取。画出来时署名一直显示（ODbL）。
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
import { basemapControl } from "@/lib/mapMarkers";
import { api } from "@/lib/canDb";
import { taxiwayLabels } from "@/lib/taxiwayLabels";
import { defaultFeatureLayers } from "@/lib/groundDefaults";
import {
  FEATURE_ORDER,
  FEATURE_STYLE,
  FEATURE_FALLBACK,
} from "@/lib/groundStyle";
import type { AirportDetail, GroundData, Procedure } from "@/lib/canDb";
import {
  loadBasemap,
  saveBasemap,
  tileSource,
  currentTheme,
  escapeHtml,
  firColor,
  watchTheme,
} from "@/lib/mapBase";
import { Spinner } from "@jianyuelab-org/can-ui";
import FilterChips from "@/components/ui/FilterChips.vue";

const props = defineProps<{
  messages: Record<string, unknown>;
  airport: AirportDetail;
}>();
const t = createTranslator(props.messages);

/** 一条腿离机场多远就算可疑。见文件头。 */
const SUSPECT_KM = 400;

const host = ref<HTMLDivElement | null>(null);
const map = shallowRef<L.Map | null>(null);
const tiles = shallowRef<L.TileLayer | null>(null);
const standLayer = shallowRef<L.LayerGroup | null>(null);
const runwayLayer = shallowRef<L.LayerGroup | null>(null);
const procLayer = shallowRef<L.LayerGroup | null>(null);
const featureLayer = shallowRef<L.LayerGroup | null>(null);

const showStands = ref(true);
/** 画哪一类程序。空串是「不画」—— 和 FilterChips 的「没选」同一个值。 */
const showProc = ref<string>("");

const showGround = ref(false);
/**
 * 每一类一个开关。
 *
 * **机位默认关着**：大场四百多个点铺满机坪，会把滑行道压得看不见 —— 而来看地面数据的
 * 人多半是在找滑行道走向。跑道那一层也关着，因为这张图本来就画着跑道（画两遍只会互相
 * 盖住，而且颜色一样）。
 */
const featureOn = ref<Record<string, boolean>>(
  defaultFeatureLayers(FEATURE_ORDER),
);

/** 图上有哪些类，各多少条。 */
const featureKinds = computed(() => {
  const g = ground.value;
  if (!g) return [];
  const n: Record<string, number> = {};
  for (const f of g.features) n[f.kind] = (n[f.kind] ?? 0) + 1;
  return FEATURE_ORDER.filter((k) => n[k]).map((k) => ({ kind: k, n: n[k] }));
});

/**
 * 有代号的滑行道，按代号排。
 *
 * 核对的人是照着代号找的（「W9 画对了没有」），所以它是一列可点的按钮而不是图上的标
 * 注 —— 标注在缩到全场时会糊成一片，而这一列点一下就跳过去并高亮。
 *
 * 同一条滑行道常被拆成好几段、代号相同，收第一段用来定位就够。
 */
const namedTaxiways = computed(() => {
  const g = ground.value;
  if (!g) return [];
  const seen = new Map<string, [number, number][]>();
  for (const f of g.features) {
    if (f.kind !== "taxiway" || !f.name) continue;
    if (!seen.has(f.name)) seen.set(f.name, f.points);
  }
  return [...seen.entries()]
    .map(([name, points]) => ({ name, points }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
});

const highlight = shallowRef<L.Polyline | null>(null);

/** 点一个滑行道代号：高亮并把视野收到它身上。 */
function focusTaxiway(points: [number, number][]) {
  const m = map.value;
  if (!m || !points.length) return;
  highlight.value?.remove();
  if (points.length < 2) {
    m.setView(points[0] as L.LatLngExpression, 17);
    return;
  }
  highlight.value = L.polyline(points as L.LatLngExpression[], {
    color: "#ffd166",
    weight: 6,
    opacity: 0.7,
    interactive: false,
  }).addTo(m);
  m.fitBounds(L.latLngBounds(points as L.LatLngExpression[]).pad(0.5));
}
const groundState = ref<"idle" | "loading" | "ready" | "none">("idle");
const ground = shallowRef<GroundData | null>(null);

const base = computed(() => props.airport);

const sids = computed(() =>
  base.value.procedures.filter((p) => p.kind === "sid"),
);
const stars = computed(() =>
  base.value.procedures.filter((p) => p.kind === "star"),
);

/** 大圆距离，公里。只用来判断一条腿是否可疑，不需要更精确的椭球公式。 */
function distanceKm(
  aLat: number,
  aLon: number,
  bLat: number,
  bLon: number,
): number {
  const R = 6371;
  const dLat = ((bLat - aLat) * Math.PI) / 180;
  const dLon = ((bLon - aLon) * Math.PI) / 180;
  const p =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((aLat * Math.PI) / 180) *
      Math.cos((bLat * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(p));
}

/** 一条程序里可疑的点数 —— 用来在图例里给个数，不只是画上去。 */
const suspectCount = computed(() => {
  const a = base.value;
  let n = 0;
  for (const p of a.procedures) {
    for (const pt of p.path) {
      if (pt.lat === null || pt.lon === null) continue;
      if (distanceKm(a.lat, a.lon, pt.lat, pt.lon) > SUSPECT_KM) n++;
    }
  }
  return n;
});

function drawRunways() {
  const layer = runwayLayer.value;
  const a = base.value;
  if (!layer) return;
  layer.clearLayers();
  for (const r of a.runways) {
    L.polyline(
      [
        [r.lat, r.lon],
        [r.endLat, r.endLon],
      ],
      { color: "#e05252", weight: 4, opacity: 0.9 },
    )
      .bindTooltip(
        `${escapeHtml(r.id)}${r.opposite ? "/" + escapeHtml(r.opposite) : ""}`,
        { sticky: true },
      )
      .addTo(layer);
  }
}

function drawStands() {
  const layer = standLayer.value;
  const a = base.value;
  if (!layer) return;
  layer.clearLayers();
  if (!showStands.value) return;
  for (const s of a.stands) {
    L.circleMarker([s.lat, s.lon], {
      radius: 3,
      color: firColor(a.fir),
      weight: 1,
      fillOpacity: 0.8,
    })
      // span 缺失时**不显示**，而不是显示 0：0 米翼展的意思是「装不下任何东西」，
      // 和「不知道」正相反。can-portal 的生成器在同一个字段上踩过这一脚。
      .bindTooltip(
        escapeHtml(s.name) + (s.span !== null ? ` · ${s.span} m` : ""),
        { direction: "top", offset: [0, -4] },
      )
      .addTo(layer);
  }
}

async function loadGround() {
  if (ground.value || groundState.value === "loading") return;
  groundState.value = "loading";
  const r = await api<GroundData>(
    `/api/v1/aip/airports/${encodeURIComponent(base.value.icao)}/ground`,
  );
  if (!r.ok) {
    groundState.value = "none";
    return;
  }
  ground.value = r.data;
  groundState.value = "ready";

  drawFeatures();
}

function drawFeatures() {
  const layer = featureLayer.value;
  if (!layer) return;
  layer.clearLayers();
  if (!showGround.value || !ground.value) return;
  for (const f of ground.value.features) {
    if (!featureOn.value[f.kind]) continue;
    const st = FEATURE_STYLE[f.kind] ?? FEATURE_FALLBACK;
    const tip =
      escapeHtml(f.name ?? f.kind) + (f.name ? ` · ${escapeHtml(f.kind)}` : "");
    // 单点的要素（等待位置、一部分机位）画成点，不是线 —— 折线要两个点才画得出来。
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
      opacity: 0.85,
    })
      .bindTooltip(tip, { sticky: true })
      .addTo(layer);
  }

  /* 滑行道编号标在图上。
   *
   * 一个编号一个标注，放在最长那一段上 —— 逐条标就是同一个 `C3` 沿着滑行道印二十遍
   * （一条滑行道在数据里是几十条被路口切开的线），糊成一条黑带。规则见 taxiwayLabels。 */
  if (featureOn.value.taxiway) {
    for (const l of taxiwayLabels(
      ground.value.features
        .filter((f) => f.kind === "taxiway" && f.name)
        .map((f) => ({ name: f.name as string, points: f.points })),
    )) {
      labelMarker(l.lat, l.lon, l.name, FEATURE_STYLE.taxiway.color).addTo(
        layer,
      );
    }
  }
}

/**
 * 一个只有字的标注。
 *
 * `interactive: false` —— 标注不该拦住底下的线：那些线是可点的（有编号的那些），而
 * 一个盖在上面的透明 div 会把点击吃掉，表现是「有的地方点得到有的地方点不到」。
 */
function labelMarker(
  lat: number,
  lon: number,
  text: string,
  color: string,
): L.Marker {
  return L.marker([lat, lon], {
    interactive: false,
    icon: L.divIcon({
      className: "can-map-icon",
      html:
        `<div class="can-fix" style="--can-fix-color:${color}">` +
        `<span class="can-fix__name can-fix__name--always">${escapeHtml(text)}</span></div>`,
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    }),
  });
}

function drawProcedures() {
  const layer = procLayer.value;
  const a = base.value;
  if (!layer) return;
  layer.clearLayers();
  if (showProc.value !== "sid" && showProc.value !== "star") return;

  const list: Procedure[] = showProc.value === "sid" ? sids.value : stars.value;
  const colour = showProc.value === "sid" ? "#4c92c1" : "#5bbd8a";

  for (const p of list) {
    // 无坐标的点是断口，不是 0,0 —— 把它当成一个点会把线拉到几内亚湾。
    // 所以断口把线**切成两段**而不是连过去。
    let run: L.LatLngExpression[] = [];
    let suspect = false;
    let runTransition: string | null = null;
    const flush = () => {
      if (run.length >= 2) {
        L.polyline(run, {
          color: suspect ? "#e0a252" : colour,
          weight: suspect ? 2 : 1.5,
          opacity: suspect ? 0.9 : 0.65,
          dashArray: suspect ? "4 4" : undefined,
        })
          .bindTooltip(
            escapeHtml(p.name) +
              (p.runway ? ` · ${escapeHtml(p.runway)}` : "") +
              (runTransition ? ` · ${escapeHtml(runTransition)}` : "") +
              (suspect ? ` · ${escapeHtml(String(t("suspect")))}` : ""),
            { sticky: true },
          )
          .addTo(layer);
      }
      run = [];
      suspect = false;
    };

    /* **一条程序的点列不是一条航迹。**
     *
     * NAIP 把一条 SID 的跑道转换和公共段全塞进同一行的 seq 序列里 —— ZGGG 的 AGVIL7
     * 是一行（跑道记作 19L），点却横跨 RW19L、RW19R、RW21、ALL 四组。整条连起来画，
     * 线会从 AGVIL 跳回 RW01L 再跳到 RW03，而每一段本身画得很漂亮，所以看不出错。
     * 346 条 SID 和 47 条 STAR 是这样。
     *
     * 换转换就断线，和无坐标处断线是同一个道理：那里本来就不连。 */
    for (const pt of p.path) {
      if (pt.lat === null || pt.lon === null) {
        flush();
        runTransition = pt.transition;
        continue;
      }
      if (pt.transition !== runTransition) {
        flush();
        runTransition = pt.transition;
      }
      if (distanceKm(a.lat, a.lon, pt.lat, pt.lon) > SUSPECT_KM) suspect = true;
      run.push([pt.lat, pt.lon]);
    }
    flush();
  }
}

/**
 * 视野。
 *
 * 只收到**跑道和机位**上，不含程序 —— 程序会伸出去一两百公里，把它算进去的话每次开图
 * 都是一张看不见跑道的省级地图。程序图层是叠加，不是主体。
 */
function fitToField() {
  const m = map.value;
  const a = base.value;
  if (!m) return;
  const pts: L.LatLngExpression[] = [[a.lat, a.lon]];
  for (const r of a.runways) {
    pts.push([r.lat, r.lon], [r.endLat, r.endLon]);
  }
  for (const s of a.stands) pts.push([s.lat, s.lon]);
  m.fitBounds(L.latLngBounds(pts).pad(0.15));
}

let basemap = loadBasemap();

function applyTiles(theme: "dark" | "light") {
  const m = map.value;
  if (!m) return;
  tiles.value?.remove();
  const source = tileSource(basemap, theme);
  tiles.value = L.tileLayer(source.url, {
    attribution: source.attribution,
    maxZoom: 18,
    maxNativeZoom: source.maxNativeZoom,
    pane: "tilePane",
  }).addTo(m);
}

let stopTheme: (() => void) | null = null;

onMounted(() => {
  if (!host.value) return;
  const m = L.map(host.value, { zoomControl: true, maxZoom: 18 });
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

  // 地面要素在最底下，别的都画在它上面。
  featureLayer.value = L.layerGroup().addTo(m);
  procLayer.value = L.layerGroup().addTo(m);
  standLayer.value = L.layerGroup().addTo(m);
  // 跑道最后加：它是这张图上最该看得见的东西。
  runwayLayer.value = L.layerGroup().addTo(m);

  drawRunways();
  drawStands();
  fitToField();

  stopTheme = watchTheme((theme) => {
    applyTiles(theme);
  });
});

onBeforeUnmount(() => {
  stopTheme?.();
  map.value?.remove();
  map.value = null;
});

watch(showStands, drawStands);
watch(showProc, drawProcedures);
watch(featureOn, drawFeatures, { deep: true });
watch(showGround, (on) => {
  if (on) void loadGround();
  drawFeatures();
});

/** 程序图层的两格。没有 SID（或 STAR）的机场那一格禁用，而不是点了没反应。 */
const procChips = computed(() => [
  {
    value: "sid",
    label: String(t("sid")),
    count: sids.value.length,
    color: "#4c92c1",
    disabled: !sids.value.length,
  },
  {
    value: "star",
    label: String(t("star")),
    count: stars.value.length,
    color: "#5bbd8a",
    disabled: !stars.value.length,
  },
]);

/**
 * 图例：只列此刻图上画着的东西。
 *
 * 色值和上面画线用的是同一组常量 —— 图例和图各写一份颜色，漂移只是时间问题。
 * 可疑段只在画了程序、而且真的有可疑点时才列：图上没有的东西出现在图例里，读的人
 * 会去找它。
 */
const legend = computed(() => {
  const items: {
    key: string;
    label: string;
    color: string;
    shape: "line" | "dash" | "dot";
  }[] = [
    {
      key: "runway",
      label: String(t("legendRunway")),
      color: "#e05252",
      shape: "line",
    },
  ];
  if (showStands.value && props.airport.stands.length)
    items.push({
      key: "stands",
      label: String(t("stands")),
      color: firColor(props.airport.fir),
      shape: "dot",
    });
  if (showProc.value === "sid")
    items.push({
      key: "sid",
      label: String(t("sid")),
      color: "#4c92c1",
      shape: "line",
    });
  if (showProc.value === "star")
    items.push({
      key: "star",
      label: String(t("star")),
      color: "#5bbd8a",
      shape: "line",
    });
  if (showProc.value && suspectCount.value)
    items.push({
      key: "suspect",
      label: String(t("legendSuspect")),
      color: "#e0a252",
      shape: "dash",
    });
  return items;
});
</script>

<template>
  <!-- `isolate`：Leaflet 的图层和控件带 400–1000 的 z-index，不圈起来会压到页面上
       吸顶的小节导航和 AppShell 的顶栏上面。 -->
  <div class="card isolate overflow-hidden">
    <!-- 所有开关集中在图的上沿一条工具栏里。选中态一律走 `.chip` 的 aria-pressed。 -->
    <div
      class="flex flex-col gap-2 border-b border-subtle px-3 py-2.5"
      role="toolbar"
      :aria-label="String(t('layers'))"
    >
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button
          type="button"
          class="chip"
          :aria-pressed="showStands"
          :disabled="!airport.stands.length"
          @click="showStands = !showStands"
        >
          <span
            class="chip__dot"
            :style="{ backgroundColor: firColor(airport.fir) }"
            aria-hidden="true"
          />
          {{ t("stands") }}
          <span class="chip__count">{{ airport.stands.length }}</span>
        </button>

        <span
          class="hidden h-4 border-l border-subtle sm:block"
          aria-hidden="true"
        />

        <FilterChips
          v-model="showProc"
          :chips="procChips"
          :label="String(t('procLayer'))"
          :all-label="String(t('procNone'))"
        />

        <span
          class="hidden h-4 border-l border-subtle sm:block"
          aria-hidden="true"
        />

        <button
          type="button"
          class="chip"
          :aria-pressed="showGround"
          @click="showGround = !showGround"
        >
          {{ t("layerGround") }}
        </button>
      </div>

      <!-- 地面要素按类别分层。取到数据才出现 —— 没开「地面」之前这一行不存在。 -->
      <div
        v-if="showGround && featureKinds.length"
        class="flex flex-wrap items-center gap-1.5"
        role="group"
        :aria-label="String(t('featureLayers'))"
      >
        <button
          v-for="k in featureKinds"
          :key="k.kind"
          type="button"
          class="chip"
          :aria-pressed="Boolean(featureOn[k.kind])"
          @click="featureOn[k.kind] = !featureOn[k.kind]"
        >
          <span
            class="chip__dot"
            :style="{
              backgroundColor: FEATURE_STYLE[k.kind]?.color ?? '#8a8a8a',
            }"
            aria-hidden="true"
          />
          {{ t("kind." + k.kind) }}
          <span class="chip__count">{{ k.n }}</span>
        </button>
      </div>
    </div>

    <!-- 图的容器始终在 DOM 里，不挂 v-if：Leaflet 绑在这个节点上，拆掉重建就是航路页那
         次「第一次好、第二次空白」。 -->
    <div class="relative">
      <div
        ref="host"
        class="h-[clamp(18rem,55svh,26rem)] w-full sm:h-[clamp(24rem,60vh,40rem)]"
        role="application"
        :aria-label="String(t('mapLabel', { icao: airport.icao }))"
      />
      <!-- 图例压在图的左下角（右下角是版权条）；手机上图太小，挪到下面的状态行里。 -->
      <ul
        class="map-panel pointer-events-none absolute bottom-3 left-3 z-[1000] hidden flex-col gap-1 px-2.5 py-2 text-xs text-muted sm:flex"
        :aria-label="String(t('legend'))"
      >
        <li v-for="l in legend" :key="l.key" class="flex items-center gap-2">
          <span
            :class="l.shape === 'dot' ? 'legend-dot' : 'legend-line'"
            :style="{ '--legend-color': l.color }"
            :data-dash="l.shape === 'dash' ? '' : undefined"
            aria-hidden="true"
          />
          {{ l.label }}
        </li>
      </ul>
    </div>

    <!-- 状态行：地面要素的状态、署名、可疑点数。 -->
    <div
      class="flex flex-col gap-1.5 border-t border-subtle px-3 py-2.5 text-xs text-muted"
    >
      <ul
        class="flex flex-wrap items-center gap-x-3 gap-y-1 sm:hidden"
        :aria-label="String(t('legend'))"
      >
        <li v-for="l in legend" :key="l.key" class="flex items-center gap-1.5">
          <span
            :class="l.shape === 'dot' ? 'legend-dot' : 'legend-line'"
            :style="{ '--legend-color': l.color }"
            :data-dash="l.shape === 'dash' ? '' : undefined"
            aria-hidden="true"
          />
          {{ l.label }}
        </li>
      </ul>

      <p
        v-if="showGround && groundState === 'loading'"
        class="flex items-center gap-2"
      >
        <Spinner size="sm" />
        {{ t("groundLoading") }}
      </p>
      <p v-else-if="showGround && groundState === 'none'">
        {{ t("groundNone") }}
      </p>
      <!-- 署名：ODbL 的硬要求，画出要素时一直显示。 -->
      <p
        v-if="showGround && ground && ground.features.length"
        class="text-faint"
      >
        {{ ground.attribution }}
      </p>

      <p v-if="suspectCount" class="text-warning">
        {{ t("suspectCount", { n: String(suspectCount) }) }}
      </p>

      <!-- 滑行道代号：核对的人照着代号找，所以是一列可点的按钮而不是图上的标注 ——
           标注缩到全场会糊成一片，这一列点一下就跳过去并高亮。 -->
      <details v-if="showGround && namedTaxiways.length">
        <summary class="cursor-pointer text-muted hover:text-ink">
          {{ t("taxiwayList", { n: String(namedTaxiways.length) }) }}
        </summary>
        <div class="mt-2 flex flex-wrap gap-1.5">
          <button
            v-for="tw in namedTaxiways"
            :key="tw.name"
            type="button"
            class="chip font-mono"
            @click="focusTaxiway(tw.points)"
          >
            {{ tw.name }}
          </button>
        </div>
      </details>
    </div>
  </div>
</template>

<style scoped>
/* 图例的小样：线就是一道 3px 的色条，可疑段是虚线，机位是圆点 —— 和图上画法一一对应。 */
.legend-line {
  width: 1rem;
  height: 0;
  flex: none;
  border-top: 3px solid var(--legend-color);
}
.legend-line[data-dash] {
  border-top-style: dashed;
  border-top-width: 2px;
}
.legend-dot {
  width: 0.5rem;
  height: 0.5rem;
  flex: none;
  border-radius: 9999px;
  background: var(--legend-color);
}
</style>
