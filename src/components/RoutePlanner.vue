<script setup lang="ts">
/**
 * 航路生成器。
 *
 * **这个岛屿不规划航路。** 它把两个机场代号发给 can-db 的 `/aip/route`，把回来的结果画出
 * 来。「从 A 到 B 该怎么飞」是一条关于这批数据的规则 —— 那条规则归后端，理由和总览页那两
 * 个统计一样：第二个消费者（can-atc 要航路线、can-efb 要飞行计划）不该把它再实现一遍，而
 * 且没有测试盯着两份实现是否一致。见 AGENTS.md 的〈这个仓库不算数据的账〉。
 *
 * 这里做的只有三件事：收输入、画地图、把限制原文摆出来。
 */
import {
  computed,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
  watch,
  nextTick,
} from "vue";
import L from "leaflet";
import {
  AlertBox,
  EmptyState,
  Icon,
  Skeleton,
  Spinner,
} from "@jianyuelab-org/can-ui";
import { createTranslator } from "@/lib/i18n";
import { api } from "@/lib/canDb";
import { HIDE_NAIP_MIN_ACCESS } from "@/lib/hideNaip";
import { useQueryState } from "@/composables/useQueryState";
import {
  TILES,
  TILE_ATTRIBUTION,
  TILE_MAX_NATIVE_ZOOM,
  ROUTE_COLORS,
  arc,
  currentTheme,
  watchTheme,
} from "@/lib/mapBase";
import {
  airportMarker,
  applyLabelZoom,
  fixMarker,
  viaMarker,
} from "@/lib/mapMarkers";

const props = defineProps<{
  messages: Record<string, unknown>;
  airports: string[];
  /**
   * 成员的 `aipAccess`，**只用来决定「未使用受限汇编」那个标签出不出**，不是权限判断。
   *
   * 开关本身是整个控制台的「隐藏 NAIP 数据」（账户菜单里，`src/lib/hideNaip.ts`），
   * `unrestricted=1` 由反代统一加上，这里不再带。
   */
  aipAccess: number;
}>();
const t = createTranslator(props.messages);

interface RouteLeg {
  airway: string;
  from: string;
  to: string;
  lat: number;
  lon: number;
  distanceKm: number;
}
interface Restriction {
  code: string | null;
  body: string;
  /**
   * `segment` = 这条限制发布的航段就在本次航路上；`airway` = 只是同一条航路，发布的
   * 航段本次不飞。两种都列，因为汇编本身不一致 —— 见 can-db 的 RouteRestriction。
   */
  scope: "segment" | "airway" | "route";
}
interface Airspace {
  /** P 禁区 / R 限制区 / D 危险区。禁区规划器会绕开，所以这里只会看到 R 和 D。 */
  kind: string;
  localType: string;
  name: string;
  reason?: string;
  /** 「byNOTAM」「每日0700-0830」—— 原文，没人解析它。 */
  activeTime?: string;
  note?: string;
  /** 米。 */
  lowerM: number;
  upperM: number;
  legs: string[];
}

interface RoutePlan {
  from: string;
  to: string;
  route: string;
  legs: RouteLeg[];
  distanceKm: number;
  directKm: number;
  /** 搜索挑中的程序；本场没有能用的程序时是空串，那一端的接入方式写在 notes 里。 */
  sid: string;
  star: string;
  /**
   * `published` = 这是汇编自己发布的城市对航线；`computed` = 库里没有发布航线，这条是
   * 按航路网算的。**两者不是同一种答案**，所以必须让人一眼看出来是哪一种。
   */
  source: "published" | "computed";
  publishedName?: string;
  /** 汇编印的总距离，量的是**航路段**；distanceKm 是机场到机场。 */
  publishedDistanceKm?: number;
  /** 米。 */
  minSafeAltM?: number;
  /** 同一个机场对还有几条发布航线。 */
  alternatives?: number;
  /** 两端机场的坐标 —— 航段只带它**到达**的那个点，见下面 draw()。 */
  fromLat: number;
  fromLon: number;
  toLat: number;
  toLon: number;
  restrictions: Restriction[];
  /** 航路穿过的限制性空域。 */
  airspaces: Airspace[];
  /** 沿途最高的最低超障高度，米。 */
  mtcaM?: number;
  /** 请求的巡航高度低于上面那个数。 */
  levelBelowMtca?: boolean;
  notes: string[];
  /** 这份计划没有把受限汇编算进来 —— can-db 自己报的，不是这里推的。 */
  unrestricted: boolean;
}

const from = ref("");
const to = ref("");
const level = ref("");
/** 标签对谁显示：3 级及以上。档下的人永远是「未使用」，对他们这不是一条信息。 */
const canChooseTier = computed(() => props.aipAccess >= HIDE_NAIP_MIN_ACCESS);
const plan = ref<RoutePlan | null>(null);
const loading = ref(false);
const error = ref("");
const copied = ref(false);

/** 代号一律大写 —— 输入框上的 `uppercase` 只是显示，值得自己转。 */
watch(from, (v) => (from.value = v.toUpperCase()));
watch(to, (v) => (to.value = v.toUpperCase()));

function swap() {
  [from.value, to.value] = [to.value, from.value];
}

/* **地址栏上的是上一次提交的值，不是输入框里正在敲的。**
 *
 * `?from=ZGGG&to=ZBAA&level=29100` 让一个结果能发给别人、刷新之后还在。只在提交时写：
 * 跟着输入框走的话，敲到一半刷新会拿一个半截代号去规划。挂载时读到两个代号就直接跑
 * 一次 —— 带着链接进来的人要的就是那条航路。 */
const qFrom = useQueryState("from");
const qTo = useQueryState("to");
const qLevel = useQueryState("level");

onMounted(() => {
  // useQueryState 的 onMounted 先跑，这时地址栏已经读进来了。
  from.value = qFrom.value.toUpperCase();
  to.value = qTo.value.toUpperCase();
  level.value = qLevel.value;
  if (from.value && to.value) void submit();
});

const known = computed(() => new Set(props.airports));
/** 提交过一次之后，没敲满四位的代号也要报。 */
const attempted = ref(false);
/**
 * 输入的机场在不在库里 —— 提交前就说，比提交后拿一个 404 好。敲满四位才判：敲到一半
 * 就亮警告，等于在人还没打完字时说他错了。
 */
function unknownCode(code: string): boolean {
  const c = code.trim();
  if (!c || (c.length < 4 && !attempted.value)) return false;
  return !known.value.has(c);
}
const fromUnknown = computed(() => unknownCode(from.value));
const toUnknown = computed(() => unknownCode(to.value));
const unknownCodes = computed(() =>
  [fromUnknown.value && from.value, toUnknown.value && to.value]
    .filter(Boolean)
    .join(", "),
);

/** 绕行只拿 `distanceKm` 比 —— `publishedDistanceKm` 量的是航路段，比出来会「比直线还短」。 */
const detour = computed(() => {
  const p = plan.value;
  if (!p || !p.directKm) return null;
  return (p.distanceKm / p.directKm) * 100 - 100;
});

interface Stat {
  key: string;
  label: string;
  value: string;
  mono?: boolean;
  danger?: boolean;
  hint?: string;
}

const stats = computed<Stat[]>(() => {
  const p = plan.value;
  if (!p) return [];
  const km = (n: number) => `${Math.round(n)} km`;
  const out: Stat[] = [
    { key: "distance", label: String(t("distance")), value: km(p.distanceKm) },
    { key: "direct", label: String(t("direct")), value: km(p.directKm) },
  ];
  if (detour.value !== null)
    out.push({
      key: "detour",
      label: String(t("detour")),
      value: `${detour.value > 0 ? "+" : ""}${detour.value.toFixed(0)}%`,
    });
  if (p.publishedDistanceKm)
    out.push({
      key: "enroute",
      label: String(t("enroute")),
      value: `${p.publishedDistanceKm} km`,
    });
  out.push({
    key: "legs",
    label: String(t("legs")),
    value: String(p.legs.length),
  });
  // 标红跟着 can-db 的 `levelBelowMtca` 走，这里不再判一次。
  if (p.mtcaM)
    out.push({
      key: "mtca",
      label: String(t("mtca")),
      value: `${p.mtcaM} m`,
      danger: !!p.levelBelowMtca,
      hint: p.levelBelowMtca ? String(t("belowMtca")) : undefined,
    });
  if (p.minSafeAltM)
    out.push({
      key: "msa",
      label: String(t("minSafeAlt")),
      value: `${p.minSafeAltM} m`,
    });
  if (p.sid) out.push({ key: "sid", label: "SID", value: p.sid, mono: true });
  if (p.star)
    out.push({ key: "star", label: "STAR", value: p.star, mono: true });
  return out;
});

async function submit() {
  attempted.value = true;
  error.value = "";
  plan.value = null;
  const f = from.value.trim().toUpperCase();
  const d = to.value.trim().toUpperCase();
  if (!f || !d) return;

  qFrom.value = f;
  qTo.value = d;
  qLevel.value = level.value.trim();

  loading.value = true;
  const params = new URLSearchParams({ from: f, to: d });
  if (level.value.trim()) params.set("level", level.value.trim());
  const result = await api<RoutePlan>(`/api/v1/aip/route?${params}`);
  loading.value = false;

  if (!result.ok) {
    error.value = result.message;
    return;
  }
  /* **每个列表字段都兜一次底。**
   *
   * 这个岛屿是 `client:only`，模板里一处 `plan.restrictions.length` 读到 null 就是一个
   * TypeError，Vue 停止渲染，页面上什么都不剩 —— 不是报错，是空白。can-db 那边有过一次：
   * 发布航线且一条限制都没有时，Go 的 nil 切片序列化成了 `null`，于是「有些航路一生成 UI
   * 就没了」。那边修好了并有测试钉着，这里仍然兜底：**后端的一次回归不该让整页消失**，
   * 而少一张卡片是能看出来的降级。 */
  const data = result.data;
  plan.value = {
    ...data,
    legs: data.legs ?? [],
    restrictions: data.restrictions ?? [],
    airspaces: data.airspaces ?? [],
    notes: data.notes ?? [],
  };
  // 地图要等 v-if 把容器渲染出来才有东西可挂。
  await nextTick();
  draw();
}

/** 把航路串复制走 —— 这一页的产物就是那一行字，让人手选是多余的摩擦。 */
async function copyRoute() {
  if (!plan.value) return;
  try {
    await navigator.clipboard.writeText(plan.value.route);
    copied.value = true;
    setTimeout(() => (copied.value = false), 1600);
  } catch {
    // 剪贴板被拒（非安全上下文、用户拒绝）不是错误 —— 那一行字就在屏幕上，
    // 手选一样拿得到。弹一个红色报错反而像航路出了问题。
  }
}

/**
 * 限制是怎么命中的：本航线 / 本段 / 同航路。三种各一个颜色、各一句解释，**不合并** ——
 * 合并等于告诉看的人它们一样确定。
 */
const SCOPES: Restriction["scope"][] = ["route", "segment", "airway"];
const SCOPE_META: Record<
  Restriction["scope"],
  { key: string; note: string; badge: string }
> = {
  route: { key: "scopeRoute", note: "scopeRouteNote", badge: "badge-danger" },
  segment: {
    key: "scopeSegment",
    note: "scopeSegmentNote",
    badge: "badge-warning",
  },
  airway: {
    key: "scopeAirway",
    note: "scopeAirwayNote",
    badge: "badge-neutral",
  },
};

/** 最确定的排最前。稳定排序，同一类里保持 can-db 给的顺序。 */
const restrictions = computed(() =>
  [...(plan.value?.restrictions ?? [])].sort(
    (a, b) => SCOPES.indexOf(a.scope) - SCOPES.indexOf(b.scope),
  ),
);
/** 图例只解释这次真出现了的那几种。 */
const scopesPresent = computed(() =>
  SCOPES.filter((sc) => restrictions.value.some((r) => r.scope === sc)),
);

const host = ref<HTMLDivElement | null>(null);
const map = shallowRef<L.Map | null>(null);
const tiles = shallowRef<L.TileLayer | null>(null);
const layer = shallowRef<L.LayerGroup | null>(null);
let stopTheme: (() => void) | null = null;

function applyTiles(theme: "dark" | "light") {
  const m = map.value;
  if (!m) return;
  tiles.value?.remove();
  tiles.value = L.tileLayer(TILES[theme], {
    attribution: TILE_ATTRIBUTION,
    maxZoom: 12,
    maxNativeZoom: TILE_MAX_NATIVE_ZOOM,
    pane: "tilePane",
  }).addTo(m);
}

function draw() {
  const p = plan.value;
  if (!p || !host.value) return;

  /* **地图必须挂在当前这个容器上。**
   *
   * 模板里整段结果是 `v-if="plan"`，而 `submit()` 开头会把 `plan` 清空 —— 于是每生成
   * 一次，这个 `div` 都会被拆掉再建一个新的。旧地图还活着，只是挂在一个已经不在文档里
   * 的节点上；`draw()` 如果只判断「地图存在吗」，第二次生成就会往那个看不见的旧地图上
   * 画，页面上是一片空白。第一次好、第二次空白，就是这么来的。
   *
   * 所以判断的是「地图挂的还是不是现在这个容器」，不是「有没有地图」。顺手把上一次的
   * 主题订阅停掉 —— 不停的话每重建一次就多一个订阅，它们抓着旧闭包不放。 */
  if (map.value && map.value.getContainer() !== host.value) {
    stopTheme?.();
    stopTheme = null;
    map.value.remove();
    map.value = null;
    layer.value = null;
    tiles.value = null;
  }

  if (!map.value) {
    const m = L.map(host.value, { zoomControl: true, minZoom: 2, maxZoom: 12 });
    map.value = m;
    applyTiles(currentTheme());
    layer.value = L.layerGroup().addTo(m);
    stopTheme = watchTheme((theme) => {
      applyTiles(theme);
      draw();
    });
    // 三类标签跟着缩放开关 —— 见 mapBase 的说明。
    m.on("zoomend", () => applyLabelZoom(m));
  }
  const m = map.value;
  const lay = layer.value;
  if (!m || !lay) return;
  lay.clearLayers();

  if (!p.legs.length) return;
  const color = ROUTE_COLORS[currentTheme()];

  /* **一段一条线，按「是不是程序」分段。**
   *
   * 程序画虚线、航路画实线，而转折的那条腿**同时属于两段** —— 否则线在换样式的地
   * 方会缺一截。这是 can-radar 的画法，照抄。 */
  const isProcedure = (l: RouteLeg) =>
    l.airway === p.sid || l.airway === p.star;

  let from: [number, number] = [p.fromLat, p.fromLon];
  let run: [number, number][] = [from];
  let runProcedure = isProcedure(p.legs[0]);

  const flush = () => {
    if (run.length < 2) return;
    L.polyline(run, {
      color,
      weight: 1.5,
      opacity: runProcedure ? 0.9 : 0.75,
      dashArray: runProcedure ? "4 4" : undefined,
      interactive: false,
    }).addTo(lay);
  };

  for (const leg of p.legs) {
    const to: [number, number] = [leg.lat, leg.lon];
    const procedure = isProcedure(leg);
    if (procedure !== runProcedure) {
      flush();
      run = [from];
      runProcedure = procedure;
    }
    // 大圆插值：直接连两点画出来的是墨卡托直线，跨度一大就和真航路差得出来。
    run.push(...arc(from, to).slice(1));
    from = to;
  }
  flush();

  /* **按「航段的连续段」标，不按每一条腿标。**
   *
   * 这一页和雷达图的场景不一样，照搬它的画法在这里是错的：雷达上一屏只有航路的一小
   * 截，每条腿都写一遍航路名才读得出「我看的这段是哪条」；而这里整条航路都在一屏
   * 里，ZGGG→ZBAA 有 38 条腿，`A461` 会沿着线重复三十几次糊成一片。
   *
   * 航路串是怎么读的，这张图就怎么标：`MIKIP A461 BUBDA W56 DUGEB` —— 名字出现在**换
   * 航路的地方**，中间那些点只决定线的形状。所以：
   *
   *   - 航路名一段一个，标在这一段的中点；很长的一段每 8 条腿补一个，免得放大之后
   *     视野里一个名字都没有。
   *   - 换航路处的那个点（也就是航路串里出现的点）名字**一直显示**。
   *   - 中间的点只画三角形，名字要放大到 9 级才出。
   */
  type Run = { airway: string; legs: RouteLeg[]; startIndex: number };
  const runs: Run[] = [];
  for (const [i, leg] of p.legs.entries()) {
    const last = runs[runs.length - 1];
    if (last && last.airway === leg.airway) last.legs.push(leg);
    else runs.push({ airway: leg.airway, legs: [leg], startIndex: i });
  }

  /** 航路串里出现的点：每一段的终点。最后一段的终点是落地机场，不算。 */
  const significant = new Set<string>();
  for (const run of runs) {
    const end = run.legs[run.legs.length - 1];
    significant.add(`${end.lat},${end.lon}`);
  }

  for (const leg of p.legs.slice(0, -1)) {
    const key = `${leg.lat},${leg.lon}`;
    fixMarker(leg.lat, leg.lon, leg.to, {
      color,
      always: significant.has(key),
      terminal: !significant.has(key),
    }).addTo(lay);
  }

  /** 一段航路上每隔这么多条腿补一个名字。 */
  const VIA_REPEAT = 8;
  for (const run of runs) {
    if (!run.airway || run.airway === "DCT" || isProcedure(run.legs[0]))
      continue;

    // 一段的起点是上一条腿的终点；第一段的起点是起飞机场。
    const before = p.legs[run.startIndex - 1];
    const head: [number, number] = before
      ? [before.lat, before.lon]
      : [p.fromLat, p.fromLon];

    const points: [number, number][] = [
      head,
      ...run.legs.map((l): [number, number] => [l.lat, l.lon]),
    ];
    for (let i = 0; i + 1 < points.length; i += VIA_REPEAT) {
      const a = points[i];
      const b = points[Math.min(i + VIA_REPEAT, points.length - 1)];
      viaMarker((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, run.airway, color, {
        always: true,
      }).addTo(lay);
    }
  }

  airportMarker(p.fromLat, p.fromLon, p.from, color).addTo(lay);
  airportMarker(p.toLat, p.toLon, p.to, color).addTo(lay);

  const bounds = L.latLngBounds([
    [p.fromLat, p.fromLon],
    ...p.legs.map((l): [number, number] => [l.lat, l.lon]),
  ]);
  m.fitBounds(bounds.pad(0.12));
  applyLabelZoom(m);
}

watch(plan, () => {
  if (!plan.value && layer.value) layer.value.clearLayers();
});

onBeforeUnmount(() => {
  stopTheme?.();
  map.value?.remove();
  map.value = null;
});
</script>

<template>
  <div class="flex flex-col gap-5">
    <form class="card flex flex-col gap-3 p-3 sm:p-4" @submit.prevent="submit">
      <div class="flex flex-wrap items-end gap-3">
        <div class="flex items-end gap-1.5">
          <div>
            <label class="mb-1 block text-xs text-muted" for="rp-from">{{
              t("from")
            }}</label>
            <input
              id="rp-from"
              v-model="from"
              class="input w-24 font-mono uppercase"
              :class="{ 'input-error': fromUnknown }"
              :aria-invalid="fromUnknown || undefined"
              aria-describedby="rp-unknown"
              maxlength="4"
              autocomplete="off"
              spellcheck="false"
              placeholder="ZGGG"
            />
          </div>
          <button
            type="button"
            class="icon-button text-muted hover:text-ink"
            :aria-label="String(t('swap'))"
            :title="String(t('swap'))"
            @click="swap"
          >
            <!-- can-ui 的图标集里没有左右互换，画一个。 -->
            <svg
              class="size-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.75"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path
                d="M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5"
              />
            </svg>
          </button>
          <div>
            <label class="mb-1 block text-xs text-muted" for="rp-to">{{
              t("to")
            }}</label>
            <input
              id="rp-to"
              v-model="to"
              class="input w-24 font-mono uppercase"
              :class="{ 'input-error': toUnknown }"
              :aria-invalid="toUnknown || undefined"
              aria-describedby="rp-unknown"
              maxlength="4"
              autocomplete="off"
              spellcheck="false"
              placeholder="ZBAA"
            />
          </div>
        </div>
        <div>
          <label class="mb-1 block text-xs text-muted" for="rp-level">{{
            t("level")
          }}</label>
          <input
            id="rp-level"
            v-model="level"
            class="input tnum w-32"
            inputmode="numeric"
            autocomplete="off"
            :placeholder="String(t('levelHint'))"
          />
        </div>
        <button
          type="submit"
          class="btn btn-primary"
          :disabled="loading || !from.trim() || !to.trim()"
        >
          <Spinner v-if="loading" size="sm" />
          {{ loading ? t("planning") : t("plan") }}
        </button>
      </div>

      <!-- 代号不在库里就提前说。提交后拿一个 404 也能懂，但那时人已经在怀疑是不是服务坏了。 -->
      <p
        id="rp-unknown"
        class="text-xs text-danger"
        :class="{ 'sr-only': !unknownCodes }"
        aria-live="polite"
      >
        <template v-if="unknownCodes">{{
          t("unknownCodes", { codes: unknownCodes })
        }}</template>
      </p>
    </form>

    <AlertBox v-if="error" variant="danger">{{ error }}</AlertBox>

    <!-- 生成中：占住结果的形状 —— 一张卡片加一张图。 -->
    <div v-if="loading" class="flex flex-col gap-5">
      <div class="card p-4 sm:p-5"><Skeleton variant="text" :count="4" /></div>
      <div class="skeleton h-[clamp(18rem,46vh,32rem)] w-full rounded-xl" />
    </div>

    <div v-else-if="!plan && !error" class="card">
      <EmptyState
        compact
        icon="map"
        :title="String(t('idleTitle'))"
        :description="String(t('idleHint'))"
      />
    </div>

    <template v-if="plan">
      <section class="card flex flex-col gap-4 p-4 sm:p-5">
        <h2 class="font-mono text-title-3 text-ink">
          {{ plan.from }} <span class="text-faint" aria-hidden="true">→</span>
          <span class="sr-only">{{ t("to") }}</span> {{ plan.to }}
        </h2>

        <!-- 这一页的产物就是这一行字：等宽、可复制、不截断。 -->
        <div
          class="flex items-start gap-2 rounded-control bg-surface-sunken p-2 pl-3"
        >
          <p
            class="min-w-0 flex-1 py-1.5 font-mono text-sm leading-relaxed break-words text-ink"
            :aria-label="String(t('routeLabel'))"
          >
            {{ plan.route }}
          </p>
          <button
            type="button"
            class="btn btn-secondary shrink-0"
            @click="copyRoute"
          >
            <Icon
              :name="copied ? 'checkCircle' : 'clipboardCheck'"
              class="size-4"
            />
            <span aria-live="polite">{{
              copied ? t("copied") : t("copy")
            }}</span>
          </button>
        </div>

        <!-- 发布的还是算的，是这一页最重要的一个字：一条是汇编说该怎么飞，另一条是
             我们按距离算出来的。摆在航路串正下方，连同那句解释，不能藏进折叠里。 -->
        <div>
          <div class="flex flex-wrap items-center gap-2">
            <span
              class="badge"
              :class="
                plan.source === 'published' ? 'badge-success' : 'badge-warning'
              "
            >
              {{
                t(
                  plan.source === "published"
                    ? "sourcePublished"
                    : "sourceComputed",
                )
              }}
            </span>
            <!-- 只对档上的人显示。1–2 级本来就永远是「未使用」，对他们这不是一条信息。
                 值取 can-db 报的 `plan.unrestricted`，不是这里的勾选框 —— 答案该由产出
                 它的那一方描述，而不是由发起请求的一方记着。 -->
            <span
              v-if="canChooseTier && plan.unrestricted"
              class="badge badge-neutral"
            >
              {{ t("unrestrictedBadge") }}
            </span>
            <span v-if="plan.publishedName" class="text-xs text-muted">{{
              plan.publishedName
            }}</span>
            <span v-if="plan.alternatives" class="text-xs text-faint">
              {{ t("alternatives", { n: String(plan.alternatives) }) }}
            </span>
          </div>
          <p class="mt-1.5 text-xs text-muted">
            {{
              t(
                plan.source === "published"
                  ? "sourcePublishedNote"
                  : "sourceComputedNote",
              )
            }}
          </p>
        </div>

        <dl class="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <div
            v-for="s in stats"
            :key="s.key"
            class="rounded-control bg-surface-sunken px-3 py-2"
            :class="{ 'ring-1 ring-danger/50': s.danger }"
          >
            <dt class="text-xs text-muted">{{ s.label }}</dt>
            <dd
              class="mt-0.5 truncate text-sm font-semibold"
              :class="[
                s.mono ? 'font-mono' : 'tnum',
                s.danger ? 'text-danger' : 'text-ink',
              ]"
              :title="s.value"
            >
              {{ s.value }}
            </dd>
            <dd v-if="s.hint" class="mt-0.5 text-xs text-danger">
              {{ s.hint }}
            </dd>
          </div>
        </dl>
      </section>

      <div
        ref="host"
        class="h-[clamp(18rem,46vh,32rem)] w-full overflow-hidden rounded-xl border border-subtle"
        role="application"
        :aria-label="String(t('mapLabel'))"
      />

      <!-- 限制是原文，不是规则，不做摘要 —— 「7800米以下可双向」这种话，摘要一次就可能
           把含义摘反。三种命中各一个颜色、各一句解释，不合并。 -->
      <section v-if="restrictions.length" class="card border-danger/40 p-4">
        <h2 class="text-sm font-semibold text-ink">
          {{ t("restrictions", { n: String(restrictions.length) }) }}
        </h2>
        <p class="mt-1 text-xs text-muted">{{ t("restrictionsNote") }}</p>
        <dl class="mt-3 space-y-1.5 text-xs">
          <div
            v-for="sc in scopesPresent"
            :key="sc"
            class="flex items-start gap-2"
          >
            <dt class="shrink-0">
              <span class="badge" :class="SCOPE_META[sc].badge">{{
                t(SCOPE_META[sc].key)
              }}</span>
            </dt>
            <dd class="pt-0.5 text-muted">{{ t(SCOPE_META[sc].note) }}</dd>
          </div>
        </dl>
        <ul
          class="mt-4 divide-y divide-[var(--border-subtle)] text-sm text-ink"
        >
          <li
            v-for="(r, i) in restrictions"
            :key="i"
            class="flex flex-wrap items-baseline gap-x-2 gap-y-1 py-2 leading-relaxed"
          >
            <span class="badge" :class="SCOPE_META[r.scope].badge">
              {{ t(SCOPE_META[r.scope].key) }}
            </span>
            <span v-if="r.code" class="badge badge-neutral font-mono">{{
              r.code
            }}</span>
            <span class="min-w-0 basis-full sm:basis-0 sm:flex-1">{{
              r.body
            }}</span>
          </li>
        </ul>
      </section>

      <!-- 穿过的限制性空域。禁区规划器已经绕开了，所以这里看到的是限制区和危险区 ——
           它们的活动时间是「byNOTAM」「每日0700-0830」这种文字，谁也没解析，所以列出来
           的是「这条航路会穿过它」，不是「今天不能飞」。那句说明必须留着。 -->
      <section v-if="plan.airspaces.length" class="card border-warning/40 p-4">
        <h2 class="text-sm font-semibold text-ink">
          {{ t("airspaces", { n: String(plan.airspaces.length) }) }}
        </h2>
        <p class="mt-1 text-xs text-muted">{{ t("airspacesNote") }}</p>
        <ul
          class="mt-3 divide-y divide-[var(--border-subtle)] text-sm text-ink"
        >
          <li v-for="(a, i) in plan.airspaces" :key="i" class="py-2">
            <div class="flex flex-wrap items-center gap-2">
              <span
                class="badge"
                :class="a.kind === 'D' ? 'badge-warning' : 'badge-danger'"
              >
                {{ a.localType }}
              </span>
              <span class="font-mono">{{ a.name }}</span>
              <span v-if="a.activeTime" class="text-xs text-muted">{{
                a.activeTime
              }}</span>
              <span class="tnum text-xs text-faint">
                {{ a.lowerM }}–{{ a.upperM || "∞" }} m
              </span>
            </div>
            <p v-if="a.reason || a.note" class="mt-1 text-xs text-muted">
              <template v-if="a.reason">{{ a.reason }}</template>
              <template v-if="a.reason && a.note"> · </template>
              <template v-if="a.note">{{ a.note }}</template>
            </p>
            <p class="mt-1 font-mono text-xs break-words text-faint">
              {{ (a.legs ?? []).join(" ") }}
            </p>
          </li>
        </ul>
      </section>

      <!-- 规划器退而求其次的地方要说出来：一条从最近航路点接入的航路，和一条走发布 SID
           的航路，在图上长得一模一样，而区别对拿去放行的人很重要。单独一张，不藏。 -->
      <AlertBox
        v-if="plan.notes.length"
        variant="warning"
        :title="String(t('notes'))"
      >
        <ul class="mt-1 list-disc space-y-1 pl-4 text-xs">
          <li v-for="(n, i) in plan.notes" :key="i">{{ n }}</li>
        </ul>
      </AlertBox>

      <section class="card overflow-hidden">
        <details>
          <summary class="cursor-pointer px-4 py-3 text-sm text-muted">
            {{ t("showLegs", { n: String(plan.legs.length) }) }}
          </summary>
          <div class="scroll-shadow-y max-h-80 overflow-y-auto">
            <table class="data-table w-full text-sm">
              <thead>
                <tr>
                  <th>{{ t("airway") }}</th>
                  <th>{{ t("fromFix") }}</th>
                  <th>{{ t("toFix") }}</th>
                  <th>{{ t("legDistance") }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(l, i) in plan.legs" :key="i">
                  <td :data-label="t('airway')" class="font-mono">
                    {{ l.airway }}
                  </td>
                  <td :data-label="t('fromFix')" class="font-mono">
                    {{ l.from }}
                  </td>
                  <td :data-label="t('toFix')" class="font-mono">{{ l.to }}</td>
                  <td :data-label="t('legDistance')" class="tnum">
                    {{ Math.round(l.distanceKm) }} km
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </details>
      </section>
    </template>
  </div>
</template>
