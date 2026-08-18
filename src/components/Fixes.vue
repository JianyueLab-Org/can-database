<script setup lang="ts">
/**
 * 按 FIR 浏览航路点。
 *
 * **必须先选 FIR，这不是分页。** 一个代号只在一个 FIR 内唯一：2608 的包里有 267 个代号
 * 指向不止一个物理点 —— `AKAGI` 在 RJJJ 和 ZLHW 各有一个，相距 3863 公里。一份按代号排
 * 的全国清单会把它们并成一行，那不是「大」，是错。所以 can-db 的 `/aip/fixes` 没有 FIR
 * 参数就直接 400，这个岛屿的第一件事也是让人选。
 *
 * ## 为什么有一个搜索框，和一个渲染上限
 *
 * RJJJ 有 3914 个航路点。**打开这一页的人几乎总是在找某一个代号**，而原来这里只有一个
 * 滚动框 —— 找 `AKAGI` 的办法是用眼睛扫三千行，或者按浏览器的 Ctrl+F 去搜一份已经渲染
 * 出来的 DOM。搜索框才是这一页的主操作。
 *
 * 上限是第二件事：三千多个 `<li>` 各带两个 `<span>`，是一万多个节点，而其中能看见的不到
 * 三十个。所以只渲染前 `RENDER_CAP` 条，并且**把省略掉的数量说出来** —— 一个悄悄截断的
 * 列表会让人以为剩下的不存在，那比慢更糟。
 */
import { computed, ref, watch } from "vue";
import { createTranslator } from "@/lib/i18n";
import { firColor } from "@/lib/mapBase";
import { api, type Fix } from "@/lib/canDb";

const props = defineProps<{
  messages: Record<string, unknown>;
  firs: string[];
}>();
const t = createTranslator(props.messages);

/** 一次最多渲染多少行。见文件头 —— 超出的部分由搜索框收敛，不是分页。 */
const RENDER_CAP = 300;

const fir = ref("");
const query = ref("");
const fixes = ref<Fix[]>([]);
const loading = ref(false);
const error = ref("");

watch(fir, async (value) => {
  fixes.value = [];
  error.value = "";
  query.value = "";
  if (!value) return;

  loading.value = true;
  const result = await api<Fix[]>(
    `/api/v1/aip/fixes?fir=${encodeURIComponent(value)}`,
  );
  loading.value = false;

  if (!result.ok) {
    error.value = result.message;
    return;
  }
  fixes.value = result.data ?? [];
});

const matched = computed(() => {
  const needle = query.value.trim().toUpperCase();
  if (!needle) return fixes.value;
  return fixes.value.filter((f) => f.ident.toUpperCase().includes(needle));
});

const shown = computed(() => matched.value.slice(0, RENDER_CAP));
const hidden = computed(() =>
  Math.max(0, matched.value.length - shown.value.length),
);
</script>

<template>
  <div>
    <div class="mb-4 flex flex-wrap items-end gap-3">
      <div>
        <label class="mb-1 block text-xs text-muted" for="fir-picker">{{
          t("pick")
        }}</label>
        <select id="fir-picker" v-model="fir" class="input w-40">
          <option value="">{{ t("pick") }}</option>
          <option v-for="f in props.firs" :key="f" :value="f">{{ f }}</option>
        </select>
      </div>

      <div v-if="fixes.length">
        <label class="mb-1 block text-xs text-muted" for="fix-search">{{
          t("search")
        }}</label>
        <input
          id="fix-search"
          v-model="query"
          type="search"
          class="input w-56"
          :placeholder="t('search')"
          autocomplete="off"
        />
      </div>

      <a
        v-if="fir"
        :href="`/map?fir=${encodeURIComponent(fir)}`"
        class="link pb-2 text-sm"
      >
        {{ t("onMap") }} →
      </a>
    </div>

    <p v-if="loading" class="text-muted">…</p>
    <p v-else-if="error" class="badge badge-danger">{{ error }}</p>
    <p
      v-else-if="fir && !fixes.length"
      class="card p-10 text-center text-muted"
    >
      {{ t("empty") }}
    </p>

    <template v-else-if="fixes.length">
      <p
        class="tnum mb-3 flex flex-wrap items-center gap-x-3 text-sm text-muted"
      >
        <span
          class="inline-block size-2 rounded-full"
          :style="{ backgroundColor: firColor(fir) }"
          aria-hidden="true"
        />
        <span v-if="query">{{
          t("matched", {
            n: String(matched.length),
            total: String(fixes.length),
          })
        }}</span>
        <span v-else>{{ t("count", { count: String(fixes.length) }) }}</span>
      </p>

      <p v-if="!matched.length" class="card p-10 text-center text-muted">
        {{ t("noMatch") }}
      </p>

      <ul
        v-else
        class="grid gap-x-6 gap-y-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
      >
        <li
          v-for="f in shown"
          :key="f.ident + f.lat"
          class="flex items-baseline justify-between gap-2 border-b border-subtle py-1"
        >
          <span class="font-mono text-sm text-ink">{{ f.ident }}</span>
          <span class="tnum text-xs text-faint"
            >{{ f.lat.toFixed(3) }}, {{ f.lon.toFixed(3) }}</span
          >
        </li>
      </ul>

      <!-- 截断要说出来。一个悄悄截断的列表会让人以为剩下的不存在。 -->
      <p v-if="hidden" class="mt-3 text-xs text-faint">
        {{ t("truncated", { n: String(hidden) }) }}
      </p>
    </template>
  </div>
</template>
