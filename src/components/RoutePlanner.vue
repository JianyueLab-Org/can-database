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
  ref,
  shallowRef,
  watch,
  nextTick,
} from "vue";
import L from "leaflet";
import { createTranslator } from "@/lib/i18n";
import { api } from "@/lib/canDb";
import {
  TILES,
  TILE_ATTRIBUTION,
  currentTheme,
  escapeHtml,
  watchTheme,
} from "@/lib/mapBase";

const props = defineProps<{
  messages: Record<string, unknown>;
  airports: string[];
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
}

const from = ref("");
const to = ref("");
const level = ref("");
const plan = ref<RoutePlan | null>(null);
const loading = ref(false);
const error = ref("");
const copied = ref(false);

const known = computed(() => new Set(props.airports));
/** 输入的机场在不在库里 —— 提交前就说，比提交后拿一个 404 好。 */
const fromKnown = computed(
  () => !from.value || known.value.has(from.value.toUpperCase()),
);
const toKnown = computed(
  () => !to.value || known.value.has(to.value.toUpperCase()),
);

const detour = computed(() => {
  const p = plan.value;
  if (!p || !p.directKm) return null;
  return (p.distanceKm / p.directKm) * 100 - 100;
});

async function submit() {
  error.value = "";
  plan.value = null;
  const f = from.value.trim().toUpperCase();
  const d = to.value.trim().toUpperCase();
  if (!f || !d) return;

  loading.value = true;
  const params = new URLSearchParams({ from: f, to: d });
  if (level.value.trim()) params.set("level", level.value.trim());
  const result = await api<RoutePlan>(`/api/v1/aip/route?${params}`);
  loading.value = false;

  if (!result.ok) {
    error.value = result.message;
    return;
  }
  plan.value = result.data;
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

/** 限制是怎么命中的：本航线 / 本段 / 同航路。 */
function scopeKey(scope: Restriction["scope"]): string {
  if (scope === "route") return "scopeRoute";
  if (scope === "segment") return "scopeSegment";
  return "scopeAirway";
}

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
    pane: "tilePane",
  }).addTo(m);
}

function draw() {
  const p = plan.value;
  if (!p || !host.value) return;

  if (!map.value) {
    const m = L.map(host.value, { zoomControl: true, minZoom: 2, maxZoom: 12 });
    map.value = m;
    applyTiles(currentTheme());
    layer.value = L.layerGroup().addTo(m);
    stopTheme = watchTheme(applyTiles);
  }
  const lay = layer.value;
  if (!lay) return;
  lay.clearLayers();

  // **线从起飞机场开始，不是从第一个航路点。** 一个航段只带它**到达**的那个点的坐
  // 标，所以照着航段画出来的线，落地机场在图上、起飞机场不在 —— 看图的人会以为
  // 数据缺了一头。起点单独取自 plan 上的机场坐标。
  const pts: L.LatLngExpression[] = [
    [p.fromLat, p.fromLon],
    ...p.legs.map((l): L.LatLngExpression => [l.lat, l.lon]),
  ];
  if (pts.length < 2) return;

  L.polyline(pts, { color: "#4c92c1", weight: 3, opacity: 0.9 }).addTo(lay);

  const mark = (
    lat: number,
    lon: number,
    label: string,
    end: boolean,
  ): void => {
    L.circleMarker([lat, lon], {
      radius: end ? 5 : 3,
      color: end ? "#e05252" : "#4c92c1",
      weight: 2,
      fillOpacity: 0.85,
    })
      .bindTooltip(escapeHtml(label), { direction: "top", offset: [0, -4] })
      .addTo(lay);
  };

  mark(p.fromLat, p.fromLon, p.from, true);
  // 每个航段的点就是它到达的那个点；最后一段到的是落地机场，所以 `l.to` 已经是
  // 机场代号，不用另外接一个。
  p.legs.forEach((l, i) => {
    mark(l.lat, l.lon, l.to, i === p.legs.length - 1);
  });
  map.value?.fitBounds(L.latLngBounds(pts).pad(0.12));
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
    <form class="flex flex-wrap items-end gap-3" @submit.prevent="submit">
      <div>
        <label class="mb-1 block text-xs text-muted" for="rp-from">{{
          t("from")
        }}</label>
        <input
          id="rp-from"
          v-model="from"
          class="input w-28 font-mono uppercase"
          maxlength="4"
          autocomplete="off"
          placeholder="ZGGG"
        />
      </div>
      <div>
        <label class="mb-1 block text-xs text-muted" for="rp-to">{{
          t("to")
        }}</label>
        <input
          id="rp-to"
          v-model="to"
          class="input w-28 font-mono uppercase"
          maxlength="4"
          autocomplete="off"
          placeholder="ZBAA"
        />
      </div>
      <div>
        <label class="mb-1 block text-xs text-muted" for="rp-level">{{
          t("level")
        }}</label>
        <input
          id="rp-level"
          v-model="level"
          class="input w-32 tnum"
          inputmode="numeric"
          autocomplete="off"
          :placeholder="String(t('levelHint'))"
        />
      </div>
      <button
        type="submit"
        class="btn btn-primary mb-px"
        :disabled="loading || !from.trim() || !to.trim()"
      >
        {{ loading ? t("planning") : t("plan") }}
      </button>
    </form>

    <!-- 代号不在库里就提前说。提交后拿一个 404 也能懂，但那时人已经在怀疑是不是服务坏了。 -->
    <p v-if="!fromKnown || !toKnown" class="text-xs text-warning">
      {{ t("unknownAirport") }}
    </p>

    <p v-if="error" class="card border-danger/40 p-4 text-sm text-danger">
      {{ error }}
    </p>

    <template v-if="plan">
      <section class="card p-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <p class="font-mono text-sm leading-relaxed text-ink">
            {{ plan.route }}
          </p>
          <button
            type="button"
            class="btn btn-secondary shrink-0"
            @click="copyRoute"
          >
            {{ copied ? t("copied") : t("copy") }}
          </button>
        </div>
        <!-- 发布的还是算的，是这一页最重要的一个字：一条是汇编说该怎么飞，另一条是
             我们按距离算出来的。摆在航路串正下方，不能藏进折叠里。 -->
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <span
            class="badge"
            :class="
              plan.source === 'published' ? 'badge-success' : 'badge-neutral'
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
          <span v-if="plan.publishedName" class="text-xs text-muted">{{
            plan.publishedName
          }}</span>
          <span v-if="plan.alternatives" class="text-xs text-faint">
            {{ t("alternatives", { n: String(plan.alternatives) }) }}
          </span>
        </div>
        <p class="mt-2 text-xs text-faint">
          {{
            t(
              plan.source === "published"
                ? "sourcePublishedNote"
                : "sourceComputedNote",
            )
          }}
        </p>

        <div class="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted">
          <span class="tnum"
            >{{ t("distance") }}: {{ Math.round(plan.distanceKm) }} km</span
          >
          <span class="tnum"
            >{{ t("direct") }}: {{ Math.round(plan.directKm) }} km</span
          >
          <span v-if="detour !== null" class="tnum">
            {{ t("detour") }}: {{ detour > 0 ? "+" : ""
            }}{{ detour.toFixed(0) }}%
          </span>
          <span v-if="plan.publishedDistanceKm" class="tnum">
            {{ t("enroute") }}: {{ plan.publishedDistanceKm }} km
          </span>
          <span v-if="plan.minSafeAltM" class="tnum">
            {{ t("minSafeAlt") }}: {{ plan.minSafeAltM }} m
          </span>
          <span
            v-if="plan.mtcaM"
            class="tnum"
            :class="{ 'text-danger': plan.levelBelowMtca }"
          >
            {{ t("mtca") }}: {{ plan.mtcaM }} m
            <template v-if="plan.levelBelowMtca">⚠</template>
          </span>
          <span class="tnum">{{ t("legs") }}: {{ plan.legs.length }}</span>
          <span v-if="plan.sid">SID: {{ plan.sid }}</span>
          <span v-if="plan.star">STAR: {{ plan.star }}</span>
        </div>
      </section>

      <!-- 规划器退而求其次的地方要说出来：一条从最近航路点接入的航路，和一条走发布 SID
           的航路，在这一页上长得一模一样，而区别对拿去放行的人很重要。 -->
      <section v-if="plan.notes.length" class="card border-warning/40 p-4">
        <h2 class="mb-2 text-sm font-semibold text-ink">{{ t("notes") }}</h2>
        <ul class="space-y-1 text-xs text-muted">
          <li v-for="(n, i) in plan.notes" :key="i">{{ n }}</li>
        </ul>
      </section>

      <div
        ref="host"
        class="h-[clamp(18rem,46vh,32rem)] w-full overflow-hidden rounded-xl border border-line"
        role="application"
        :aria-label="String(t('mapLabel'))"
      />

      <!-- 穿过的限制性空域。禁区规划器已经绕开了，所以这里看到的是限制区和危险区 ——
           它们的活动时间是「byNOTAM」「每日0700-0830」这种文字，谁也没解析，所以列出来
           的是「这条航路会穿过它」，不是「今天不能飞」。 -->
      <section v-if="plan.airspaces.length" class="card border-warning/40 p-4">
        <h2 class="mb-2 text-sm font-semibold text-ink">
          {{ t("airspaces", { n: String(plan.airspaces.length) }) }}
        </h2>
        <p class="mb-3 text-xs text-faint">{{ t("airspacesNote") }}</p>
        <ul class="space-y-3 text-sm text-ink">
          <li v-for="(a, i) in plan.airspaces" :key="i">
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
            <p class="mt-1 font-mono text-xs text-faint">
              {{ a.legs.join(" ") }}
            </p>
          </li>
        </ul>
      </section>

      <!-- 限制是原文，不是规则。这一段刻意排在最显眼的位置之一，而且不做摘要 ——
           「7800米以下可双向」这种话，摘要一次就可能把含义摘反。 -->
      <section
        v-if="plan.restrictions.length"
        class="card border-danger/40 p-4"
      >
        <h2 class="mb-2 text-sm font-semibold text-ink">
          {{ t("restrictions", { n: String(plan.restrictions.length) }) }}
        </h2>
        <p class="mb-3 text-xs text-faint">{{ t("restrictionsNote") }}</p>
        <!-- 「同航路」那一类必须解释，否则看的人会以为它和直接命中一样确定。 -->
        <p class="mb-3 text-xs text-faint">{{ t("scopeNote") }}</p>
        <ul class="space-y-2 text-sm text-ink">
          <li
            v-for="(r, i) in plan.restrictions"
            :key="i"
            class="leading-relaxed"
          >
            <span
              class="badge mr-2"
              :class="r.scope === 'airway' ? 'badge-neutral' : 'badge-danger'"
            >
              {{ t(scopeKey(r.scope)) }}
            </span>
            <span v-if="r.code" class="badge badge-neutral mr-2">{{
              r.code
            }}</span>
            {{ r.body }}
          </li>
        </ul>
      </section>

      <section class="card overflow-hidden">
        <details>
          <summary class="cursor-pointer px-4 py-3 text-sm text-muted">
            {{ t("showLegs", { n: String(plan.legs.length) }) }}
          </summary>
          <div class="scroll-edge-y max-h-80 overflow-y-auto">
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
