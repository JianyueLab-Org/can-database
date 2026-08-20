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
 * ## 地面线画是**按需取**的，而且画的是图上的原色
 *
 * 一个大场的线画是五千多条线、两万多个点，跟机场详情一起拖等于每次打开机场页都多下
 * 一兆多几何 —— 而多数人来这一页是看跑道和频率的。所以它单独一条路由，勾上才取。
 *
 * 颜色用 can-db 存的**图上原色**，不重新配色：那些线没有语义（图上只有颜色和线宽，
 * 没有一个字说哪条是滑行道中线），自己配色等于替它做一个没有依据的分类。原色画出来
 * 就是原图的样子。
 *
 * 唯一的例外是**看不见的那一档**：图上的颜色是配着白纸选的，所以深色底图上纯黑的线、
 * 浅色底图上近白的线都会消失。那种情况只调亮度、保住色相 —— 让线看得见是必要的，把
 * 橙线改成蓝线不是。
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
import type { AirportDetail, GroundLines, Procedure } from "@/lib/canDb";
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
const groundLayer = shallowRef<L.LayerGroup | null>(null);

const showStands = ref(true);
const showProc = ref<"none" | "sid" | "star">("none");

const showGround = ref(false);
const groundState = ref<"idle" | "loading" | "ready" | "none">("idle");
const ground = shallowRef<GroundLines | null>(null);

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
  const r = await api<GroundLines>(
    `/api/v1/aip/airports/${encodeURIComponent(base.value.icao)}/ground`,
  );
  if (!r.ok) {
    groundState.value = "none";
    return;
  }
  ground.value = r.data;
  groundState.value = "ready";
  drawGround();
}

/**
 * 把和底图撞在一起的那一档亮度拉开，色相不动。
 *
 * 航图的颜色是配着白纸选的：黑线在深色底图上、近白的线在浅色底图上都会整条消失。这里
 * 只在**确实看不见**的时候动手（亮度太低或太高），而且是整体缩放 RGB —— 橙线还是橙线。
 */
function visible(rgb: string, theme: "dark" | "light"): string {
  const m = /^#([0-9a-f]{6})$/i.exec(rgb);
  if (!m) return rgb;
  const n = parseInt(m[1], 16);
  let r = (n >> 16) & 255,
    g = (n >> 8) & 255,
    b = n & 255;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const scale =
    theme === "dark" && lum < 0.3
      ? (0.55 + lum) / Math.max(lum, 0.02)
      : theme === "light" && lum > 0.85
        ? 0.65 / lum
        : 1;
  if (scale === 1) return rgb;
  const clamp = (v: number) =>
    Math.min(255, Math.max(0, Math.round(v * scale)));
  // 纯黑乘任何系数还是黑，所以那一档给一个固定的灰。
  if (lum < 0.02) return theme === "dark" ? "#8c8c8c" : rgb;
  r = clamp(r);
  g = clamp(g);
  b = clamp(b);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

function drawGround() {
  const layer = groundLayer.value;
  if (!layer) return;
  layer.clearLayers();
  if (!showGround.value || !ground.value) return;
  const theme = currentTheme();
  for (const l of ground.value.lines) {
    L.polyline(l.points as L.LatLngExpression[], {
      color: visible(l.rgb, theme),
      // 图上的线宽是米，屏幕上要的是像素。按米直接当像素画，缩到全场时整张图会糊成
      // 一块 —— 所以只用它分粗细，压到 0.5–2 像素之间。
      weight: Math.min(2, Math.max(0.5, l.widthM / 4)),
      opacity: 0.75,
      interactive: false,
    }).addTo(layer);
  }
}

function drawProcedures() {
  const layer = procLayer.value;
  const a = base.value;
  if (!layer) return;
  layer.clearLayers();
  if (showProc.value === "none") return;

  const list: Procedure[] = showProc.value === "sid" ? sids.value : stars.value;
  const colour = showProc.value === "sid" ? "#4c92c1" : "#5bbd8a";

  for (const p of list) {
    // 无坐标的点是断口，不是 0,0 —— 把它当成一个点会把线拉到几内亚湾。
    // 所以断口把线**切成两段**而不是连过去。
    let run: L.LatLngExpression[] = [];
    let suspect = false;
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
              (suspect ? ` · ${escapeHtml(String(t("suspect")))}` : ""),
            { sticky: true },
          )
          .addTo(layer);
      }
      run = [];
      suspect = false;
    };

    for (const pt of p.path) {
      if (pt.lat === null || pt.lon === null) {
        flush();
        continue;
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

function applyTiles(theme: "dark" | "light") {
  const m = map.value;
  if (!m) return;
  tiles.value?.remove();
  tiles.value = L.tileLayer(TILES[theme], {
    attribution: TILE_ATTRIBUTION,
    maxZoom: 18,
    pane: "tilePane",
  }).addTo(m);
}

let stopTheme: (() => void) | null = null;

onMounted(() => {
  if (!host.value) return;
  const m = L.map(host.value, { zoomControl: true, maxZoom: 18 });
  map.value = m;
  applyTiles(currentTheme());

  // 线画在最底下：它是底图，别的都画在它上面。
  groundLayer.value = L.layerGroup().addTo(m);
  procLayer.value = L.layerGroup().addTo(m);
  standLayer.value = L.layerGroup().addTo(m);
  // 跑道最后加：它是这张图上最该看得见的东西。
  runwayLayer.value = L.layerGroup().addTo(m);

  drawRunways();
  drawStands();
  fitToField();

  stopTheme = watchTheme((theme) => {
    applyTiles(theme);
    drawGround(); // 线的颜色跟着主题走，见 visible()
  });
});

onBeforeUnmount(() => {
  stopTheme?.();
  map.value?.remove();
  map.value = null;
});

watch(showStands, drawStands);
watch(showProc, drawProcedures);
watch(showGround, (on) => {
  if (on) void loadGround();
  drawGround();
});
</script>

<template>
  <div class="flex flex-col gap-3">
    <div class="flex flex-wrap items-center gap-4 text-xs text-muted">
      <label class="flex items-center gap-2">
        <input v-model="showStands" type="checkbox" class="accent-can" />
        {{ t("layerStands", { n: String(airport.stands.length) }) }}
      </label>

      <div class="flex items-center gap-1.5">
        <button
          v-for="opt in ['none', 'sid', 'star'] as const"
          :key="opt"
          type="button"
          class="rounded-full border px-2.5 py-1 transition"
          :class="
            showProc === opt
              ? 'border-can bg-can/10 text-ink'
              : 'border-line text-muted hover:border-can/40'
          "
          :disabled="
            opt === 'sid'
              ? !sids.length
              : opt === 'star'
                ? !stars.length
                : false
          "
          @click="showProc = opt"
        >
          {{
            opt === "none"
              ? t("procNone")
              : opt === "sid"
                ? t("procSid", { n: String(sids.length) })
                : t("procStar", { n: String(stars.length) })
          }}
        </button>
      </div>

      <label class="flex items-center gap-2">
        <input v-model="showGround" type="checkbox" class="accent-can" />
        {{ t("layerGround") }}
      </label>

      <span v-if="showGround && groundState === 'loading'">
        {{ t("groundLoading") }}
      </span>
      <span v-else-if="showGround && groundState === 'none'">
        {{ t("groundNone") }}
      </span>
      <span v-else-if="showGround && ground" class="text-muted">
        {{ t("groundAccuracy", { n: ground.accuracyM.toFixed(0) }) }}
        <template v-if="ground.runways === 0">
          · {{ t("groundUnchecked") }}
        </template>
      </span>

      <span v-if="suspectCount" class="text-warning">
        {{ t("suspectCount", { n: String(suspectCount) }) }}
      </span>
    </div>

    <div
      ref="host"
      class="h-[clamp(20rem,52vh,34rem)] w-full overflow-hidden rounded-xl border border-line"
      role="application"
      :aria-label="String(t('mapLabel', { icao: airport.icao }))"
    />
  </div>
</template>
