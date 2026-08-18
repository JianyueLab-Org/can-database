<script setup lang="ts">
/**
 * 按 FIR 浏览航路点。
 *
 * **必须先选 FIR，这不是分页。** 一个代号只在一个 FIR 内唯一：2608 的包里有 267
 * 个代号指向不止一个物理点 —— `AKAGI` 在 RJJJ 和 ZLHW 各有一个，相距 3863 公里。
 * 一份按代号排的全国清单会把它们并成一行，那不是「大」，是错。所以 can-db 的
 * `/aip/fixes` 没有 FIR 参数就直接 400，这个岛屿的第一件事也是让人选。
 */
import { ref, watch } from "vue";
import { createTranslator } from "@/lib/i18n";
import { api, type Fix } from "@/lib/canDb";

const props = defineProps<{
  messages: Record<string, unknown>;
  firs: string[];
}>();
const t = createTranslator(props.messages);

const fir = ref("");
const fixes = ref<Fix[]>([]);
const loading = ref(false);
const error = ref("");

watch(fir, async (value) => {
  fixes.value = [];
  error.value = "";
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
  fixes.value = result.data;
});
</script>

<template>
  <div>
    <label class="sr-only" for="fir-picker">{{ t("pick") }}</label>
    <select id="fir-picker" v-model="fir" class="input mb-4 max-w-xs">
      <option value="">{{ t("pick") }}</option>
      <option v-for="f in props.firs" :key="f" :value="f">{{ f }}</option>
    </select>

    <p v-if="loading" class="text-muted">…</p>
    <p v-else-if="error" class="badge badge-danger">{{ error }}</p>
    <p
      v-else-if="fir && !fixes.length"
      class="card p-10 text-center text-muted"
    >
      {{ t("empty") }}
    </p>

    <template v-else-if="fixes.length">
      <p class="tnum mb-3 text-sm text-muted">
        {{ t("count", { count: fixes.length }) }}
      </p>
      <ul
        class="grid gap-1 sm:grid-cols-3 lg:grid-cols-4"
        style="max-height: 60vh; overflow-y: auto"
      >
        <li
          v-for="f in fixes"
          :key="f.ident + f.lat"
          class="flex items-baseline justify-between gap-2 border-b border-subtle py-1"
        >
          <span class="font-mono text-sm text-ink">{{ f.ident }}</span>
          <span class="tnum text-xs text-faint"
            >{{ f.lat.toFixed(3) }}, {{ f.lon.toFixed(3) }}</span
          >
        </li>
      </ul>
    </template>
  </div>
</template>
