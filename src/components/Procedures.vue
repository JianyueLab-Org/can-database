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
 * 某个点在不在这条程序上）。
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

const kind = ref<Kind | "">("");
const runway = ref("");
const query = ref("");
const open = ref<Set<string>>(new Set());

const keyOf = (p: Procedure) => `${p.kind}/${p.name}/${p.runway ?? ""}`;

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

const counts = computed(() => {
  const m: Record<string, number> = { sid: 0, star: 0, approach: 0 };
  for (const p of props.procedures) m[p.kind] = (m[p.kind] ?? 0) + 1;
  return m;
});

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

/** 腿上除了代号还有什么 —— 收起时用它给一行摘要。 */
function summary(p: Procedure): string {
  const idents = p.path.map((pt) => pt.ident || pt.path || "·");
  if (idents.length <= 8) return idents.join(" ");
  return `${idents.slice(0, 6).join(" ")} … ${idents[idents.length - 1]}`;
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex flex-wrap items-end gap-3">
      <div class="min-w-48 flex-1">
        <label class="mb-1 block text-xs text-muted" for="proc-q">{{
          t("search")
        }}</label>
        <input
          id="proc-q"
          v-model="query"
          class="input w-full"
          type="search"
          autocomplete="off"
          :placeholder="String(t('searchHint'))"
        />
      </div>
      <div>
        <label class="mb-1 block text-xs text-muted" for="proc-kind">{{
          t("kind")
        }}</label>
        <select id="proc-kind" v-model="kind" class="input w-36">
          <option value="">{{ t("kindAll") }}</option>
          <option v-for="k in KINDS" :key="k" :value="k">
            {{ t(k) }} ({{ counts[k] ?? 0 }})
          </option>
        </select>
      </div>
      <div v-if="runways.length">
        <label class="mb-1 block text-xs text-muted" for="proc-rwy">{{
          t("runway")
        }}</label>
        <select id="proc-rwy" v-model="runway" class="input w-28">
          <option value="">{{ t("runwayAll") }}</option>
          <option v-for="r in runways" :key="r" :value="r">{{ r }}</option>
        </select>
      </div>
    </div>

    <p class="text-xs text-faint">
      {{
        t("showing", {
          n: String(matched.length),
          all: String(procedures.length),
        })
      }}
    </p>

    <ul class="space-y-1.5">
      <li v-for="p in matched" :key="keyOf(p)" class="card overflow-hidden">
        <button
          type="button"
          class="flex w-full items-baseline gap-2 p-3 text-left"
          @click="toggle(p)"
        >
          <span
            class="badge shrink-0"
            :class="
              p.kind === 'sid'
                ? 'badge-info'
                : p.kind === 'star'
                  ? 'badge-success'
                  : 'badge-warning'
            "
          >
            {{ t(p.kind) }}
          </span>
          <span class="font-mono text-sm font-semibold text-ink">{{
            p.name
          }}</span>
          <span class="shrink-0 font-mono text-xs text-faint">{{
            runwaysOf(p).join(" ")
          }}</span>
          <span
            class="min-w-0 flex-1 truncate text-right font-mono text-xs text-muted"
          >
            {{ summary(p) }}
          </span>
          <span class="shrink-0 text-xs text-faint">{{
            open.has(keyOf(p)) ? "−" : "+"
          }}</span>
        </button>

        <div
          v-if="open.has(keyOf(p))"
          class="scroll-shadow-x overflow-x-auto border-t border-line"
        >
          <table class="data-table w-full text-sm">
            <thead>
              <tr>
                <th>#</th>
                <th>{{ t("fix") }}</th>
                <th>{{ t("path") }}</th>
                <th>{{ t("alt") }}</th>
                <th>{{ t("speed") }}</th>
                <th>{{ t("via") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(pt, i) in p.path" :key="i">
                <td :data-label="'#'" class="tnum text-faint">{{ i + 1 }}</td>
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
                <td :data-label="t('speed')" class="tnum text-xs">
                  {{ pt.speedKt ? `${pt.speedKt}` : "—" }}
                  <span v-if="pt.speedKind" class="text-faint">{{
                    pt.speedKind
                  }}</span>
                </td>
                <td :data-label="t('via')" class="font-mono text-xs text-faint">
                  {{ pt.transition ?? pt.part ?? "—" }}
                </td>
              </tr>
            </tbody>
          </table>
          <p class="px-3 py-2 text-xs text-faint">{{ t("altNote") }}</p>
        </div>
      </li>
    </ul>

    <p v-if="!matched.length" class="card p-6 text-center text-sm text-muted">
      {{ t("none") }}
    </p>
  </div>
</template>
