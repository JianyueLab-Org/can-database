<script setup lang="ts">
/**
 * 一个机场的离场、进场和进近。
 *
 * ## 为什么是岛屿而不是一段静态列表
 *
 * ZSPD 有 **122 条程序、1479 条腿**。原来这一段是三栏卡片，每条程序把全部腿拼成一行等宽
 * 字 —— 一屏放不下三条，而打开这一页的人几乎总是在找**某一条**（「36L 的 IDKE5Y 长什么
 * 样」「01 号跑道有哪些进近」）。按仓库自己的规矩：能被搜的清单一定要有搜索框。
 *
 * 三个筛子对应三种真实问法：**按跑道**（放行前挑程序）、**按类别**、**按名字或点**（核对
 * 某个点在不在这条程序上）。三个都写进地址栏（`proc` / `kind` / `rwy`），「把这一屏发给
 * 别人」和「刷新之后还在原处」不需要别的代码。
 *
 * 这一页的 `/` 归这里的搜索框：程序是页上最长、最常被搜的清单，机位表不抢。Enter 在只剩
 * 一条时直接展开它。
 *
 * ## 按类别分组
 *
 * 不筛类别时分成离场 / 进场 / 进近三组，各带组名和条数 —— SID 和 STAR 名字长得一样（都是
 * 五字母加数字加字母），只靠行首一个小标签分不清读到哪一类了。组是渲染，不是数据规则。
 *
 * ## 腿默认收起
 *
 * 收起时一条程序占一行，展开才出腿表。1479 条腿全展开是一万多个 DOM 节点，而其中能看见
 * 的不到二十条 —— 和航路点页那条上限同一个理由。
 *
 * ## 腿表里不解码高度限制
 *
 * `alt` 是 ARINC 424 的编码字符串（`05910B03940A`：8100 米以下、5910 米以上）。这里**原样
 * 印**，理由和限制原文一样：解码要判 A/B/+/- 的语义，而一个解错的高度限制比不解更危险。
 */
import { computed, ref } from "vue";
import { EmptyState, Icon } from "@jianyuelab-org/can-ui";
import SearchField from "@/components/ui/SearchField.vue";
import FilterChips from "@/components/ui/FilterChips.vue";
import { useQueryState } from "@/composables/useQueryState";
import { createTranslator } from "@/lib/i18n";
import type { Procedure } from "@/lib/canDb";

const props = defineProps<{
  messages: Record<string, unknown>;
  procedures: Procedure[];
  /** 这个机场的跑道代号，用来出跑道筛选。 */
  runways: string[];
}>();
const t = createTranslator(props.messages);

const KINDS = ["sid", "star", "approach"] as const;
type Kind = (typeof KINDS)[number];

/** 每一类的色：标签和行首那道竖条同一个色，SID 蓝、STAR 绿、进近琥珀，和机场图同一套。 */
const KIND_STYLE: Record<Kind, { badge: string; bar: string }> = {
  sid: { badge: "badge-info", bar: "proc-bar--sid" },
  star: { badge: "badge-success", bar: "proc-bar--star" },
  approach: { badge: "badge-warning", bar: "proc-bar--approach" },
};

const query = useQueryState("proc");
const kindRaw = useQueryState("kind");
const runwayRaw = useQueryState("rwy");

/* 地址栏里的值是别人手打或者旧链接带来的，不认识的当作没筛 —— 否则一个拼错的
   `?kind=sids` 会让整节显示「没有匹配」，看着像这个机场没有程序。 */
const kind = computed<Kind | "">({
  get: () =>
    (KINDS as readonly string[]).includes(kindRaw.value)
      ? (kindRaw.value as Kind)
      : "",
  set: (v) => (kindRaw.value = v),
});
const runway = computed<string>({
  get: () => (props.runways.includes(runwayRaw.value) ? runwayRaw.value : ""),
  set: (v) => (runwayRaw.value = v),
});

const open = ref<Set<string>>(new Set());

const keyOf = (p: Procedure) => `${p.kind}/${p.name}/${p.runway ?? ""}`;
const domId = (p: Procedure) =>
  "proc-" + keyOf(p).replace(/[^A-Za-z0-9_-]/g, "_");

function toggle(p: Procedure) {
  const k = keyOf(p);
  const next = new Set(open.value);
  if (next.has(k)) next.delete(k);
  else next.add(k);
  open.value = next;
}

/** 这条程序服务哪些跑道 —— `runways` 是逗号分隔的全部，`runway` 只是第一条。 */
function runwaysOf(p: Procedure): string[] {
  const raw = p.runways ?? p.runway ?? "";
  return raw
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

const kindChips = computed(() => {
  const m: Record<string, number> = { sid: 0, star: 0, approach: 0 };
  for (const p of props.procedures) m[p.kind] = (m[p.kind] ?? 0) + 1;
  return KINDS.map((k) => ({
    value: k,
    label: t(k),
    count: m[k] ?? 0,
    disabled: !m[k],
  }));
});

const runwayChips = computed(() => {
  const m: Record<string, number> = {};
  for (const p of props.procedures)
    for (const r of runwaysOf(p)) m[r] = (m[r] ?? 0) + 1;
  return props.runways.map((r) => ({
    value: r,
    label: r,
    count: m[r] ?? 0,
    mono: true,
    disabled: !m[r],
  }));
});

const filtered = computed(
  () => Boolean(query.value.trim()) || Boolean(kind.value || runway.value),
);

const matched = computed(() => {
  const needle = query.value.trim().toUpperCase();
  return props.procedures.filter((p) => {
    if (kind.value && p.kind !== kind.value) return false;
    if (runway.value && !runwaysOf(p).includes(runway.value)) return false;
    if (!needle) return true;
    if (p.name.toUpperCase().includes(needle)) return true;
    // 按点搜：「哪几条程序经过 AA111」是这一页的第二种问法。
    return p.path.some((pt) => pt.ident.toUpperCase().includes(needle));
  });
});

const groups = computed(() =>
  KINDS.map((k) => ({
    kind: k,
    items: matched.value.filter((p) => p.kind === k),
  })).filter((g) => g.items.length),
);

function clearFilters() {
  query.value = "";
  kindRaw.value = "";
  runwayRaw.value = "";
}

/** Enter：只剩一条就展开它，省一次点击。 */
function onSubmit() {
  if (matched.value.length !== 1) return;
  const p = matched.value[0];
  if (!open.value.has(keyOf(p))) toggle(p);
}

/** 腿上除了代号还有什么 —— 收起时用它给一行摘要。 */
function summary(p: Procedure): string {
  const idents = p.path.map((pt) => pt.ident || pt.path || "·");
  if (idents.length <= 8) return idents.join(" ");
  return `${idents.slice(0, 6).join(" ")} … ${idents[idents.length - 1]}`;
}
</script>

<template>
  <EmptyState
    v-if="!procedures.length"
    compact
    icon="paperAirplane"
    :title="t('empty')"
  />

  <div v-else class="flex flex-col gap-4">
    <div class="flex flex-col gap-3">
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div class="min-w-48 flex-1 sm:max-w-sm">
          <SearchField
            v-model="query"
            :label="t('search')"
            :placeholder="t('searchHint')"
            uppercase
            @submit="onSubmit"
          />
        </div>
        <p class="tnum text-xs text-faint" aria-live="polite">
          {{
            filtered
              ? t("showing", {
                  n: String(matched.length),
                  all: String(procedures.length),
                })
              : t("total", { n: String(procedures.length) })
          }}
        </p>
      </div>
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span class="text-eyebrow w-12 shrink-0 text-faint">{{
          t("kind")
        }}</span>
        <FilterChips
          v-model="kind"
          :chips="kindChips"
          :label="t('kind')"
          :all-label="t('kindAll')"
          :all-count="procedures.length"
        />
      </div>
      <div
        v-if="runways.length"
        class="flex flex-wrap items-center gap-x-2 gap-y-1.5"
      >
        <span class="text-eyebrow w-12 shrink-0 text-faint">{{
          t("runway")
        }}</span>
        <FilterChips
          v-model="runway"
          :chips="runwayChips"
          :label="t('runway')"
          :all-label="t('runwayAll')"
        />
      </div>
    </div>

    <EmptyState
      v-if="!matched.length"
      compact
      icon="magnifyingGlass"
      :title="t('none')"
    >
      <template #action>
        <button type="button" class="btn btn-soft" @click="clearFilters">
          {{ t("clear") }}
        </button>
      </template>
    </EmptyState>

    <section
      v-for="g in groups"
      :key="g.kind"
      class="flex flex-col gap-1.5"
      :aria-label="t(g.kind)"
    >
      <h3 class="flex items-center gap-2 text-sm font-semibold text-ink">
        <span class="proc-dot" :class="KIND_STYLE[g.kind].bar" />
        {{ t(g.kind + "Group") }}
        <span class="tnum font-normal text-faint">{{ g.items.length }}</span>
      </h3>

      <ul class="flex flex-col gap-1.5">
        <li
          v-for="p in g.items"
          :key="keyOf(p)"
          class="card proc-bar overflow-hidden"
          :class="KIND_STYLE[p.kind as Kind]?.bar"
        >
          <button
            type="button"
            class="flex w-full items-center gap-2 px-3 py-2.5 text-left hover:bg-surface-sunken focus-visible:bg-surface-sunken focus-visible:outline-none"
            :aria-expanded="open.has(keyOf(p))"
            :aria-controls="domId(p)"
            @click="toggle(p)"
          >
            <Icon
              name="chevronRight"
              class="size-4 shrink-0 text-faint transition-transform duration-150"
              :class="{ 'rotate-90': open.has(keyOf(p)) }"
            />
            <span
              class="badge shrink-0"
              :class="KIND_STYLE[p.kind as Kind]?.badge ?? 'badge-neutral'"
            >
              {{ t(p.kind) }}
            </span>
            <span class="font-mono text-sm font-semibold text-ink">{{
              p.name
            }}</span>
            <span class="shrink-0 font-mono text-xs text-muted">{{
              runwaysOf(p).join(" ")
            }}</span>
            <span
              class="hidden min-w-0 flex-1 truncate text-right font-mono text-xs text-faint sm:block"
            >
              {{ summary(p) }}
            </span>
            <span class="tnum ml-auto shrink-0 text-xs text-faint sm:ml-0">{{
              t("legs", { n: String(p.path.length) })
            }}</span>
          </button>

          <div
            v-if="open.has(keyOf(p))"
            :id="domId(p)"
            class="scroll-shadow-x overflow-x-auto border-t border-subtle"
          >
            <table class="data-table w-full text-sm">
              <thead>
                <tr>
                  <th class="text-right">#</th>
                  <th>{{ t("fix") }}</th>
                  <th>{{ t("path") }}</th>
                  <th>{{ t("alt") }}</th>
                  <th class="text-right">{{ t("speedKt") }}</th>
                  <th>{{ t("via") }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(pt, i) in p.path" :key="i">
                  <td :data-label="'#'" class="tnum text-right text-faint">
                    {{ i + 1 }}
                  </td>
                  <td :data-label="t('fix')" class="font-mono">
                    <!-- 没有定位点的腿印一个破折号，不留空：空白会被读成「这里缺数据」，
                         而 CA/VI 本来就终止在高度或航向上。 -->
                    {{ pt.ident || "—" }}
                    <span v-if="pt.flyover" class="badge badge-neutral ml-1"
                      >FO</span
                    >
                    <span v-if="pt.isMap" class="badge badge-danger ml-1"
                      >MAP</span
                    >
                  </td>
                  <td :data-label="t('path')" class="font-mono text-xs">
                    {{ pt.path ?? "—" }}
                    <span v-if="pt.turn" class="text-faint">{{ pt.turn }}</span>
                  </td>
                  <td :data-label="t('alt')" class="font-mono text-xs">
                    {{ pt.alt ?? "—" }}
                  </td>
                  <td
                    :data-label="t('speedKt')"
                    class="tnum text-right text-xs"
                  >
                    {{ pt.speedKt ? `${pt.speedKt}` : "—" }}
                    <span v-if="pt.speedKind" class="text-faint">{{
                      pt.speedKind
                    }}</span>
                  </td>
                  <td
                    :data-label="t('via')"
                    class="font-mono text-xs text-faint"
                  >
                    {{ pt.transition ?? pt.part ?? "—" }}
                  </td>
                </tr>
              </tbody>
            </table>
            <!-- 这句必须留着：`alt` 长得像一串数字，读的人会以为是米或英尺。 -->
            <p class="px-3 py-2 text-xs text-faint">{{ t("altNote") }}</p>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
/* 行首一道类别色竖条。色值和机场图上 SID / STAR 的线同源（#4c92c1 / #5bbd8a），
   进近用那边等待位置的琥珀色 —— 同一页两处的颜色说的是同一件事。 */
.proc-bar {
  border-left-width: 3px;
}
.proc-bar--sid {
  --proc-color: #4c92c1;
}
.proc-bar--star {
  --proc-color: #5bbd8a;
}
.proc-bar--approach {
  --proc-color: #e0a252;
}
.proc-bar.proc-bar--sid,
.proc-bar.proc-bar--star,
.proc-bar.proc-bar--approach {
  border-left-color: var(--proc-color);
}
.proc-dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 9999px;
  background: var(--proc-color);
}
</style>
