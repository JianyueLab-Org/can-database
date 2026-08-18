<script setup lang="ts">
/**
 * 机场清单，带一个即时过滤框。
 *
 * 岛屿而不是服务端渲染，因为这一页唯一的操作就是「找那个机场」，而 233 行里翻找
 * 不如敲四个字母。清单整份随页面下来（每条五个字段，比图标精灵图还小），所以过滤
 * 是本地的 —— 每敲一个键往返一次服务器是这一页最容易犯的错。
 */
import { computed, ref } from "vue";
import { createTranslator } from "@/lib/i18n";
import type { Airport } from "@/lib/canDb";

const props = defineProps<{
  messages: Record<string, unknown>;
  airports: Airport[];
}>();
const t = createTranslator(props.messages);

const query = ref("");

const shown = computed(() => {
  const needle = query.value.trim().toUpperCase();
  if (!needle) return props.airports;
  return props.airports.filter(
    (a) =>
      a.icao.includes(needle) ||
      (a.fir ?? "").includes(needle) ||
      (a.name ?? "").toUpperCase().includes(needle),
  );
});
</script>

<template>
  <div>
    <label class="sr-only" for="airport-search">{{ t("search") }}</label>
    <input
      id="airport-search"
      v-model="query"
      type="search"
      class="input mb-4 max-w-sm"
      :placeholder="t('search')"
      autocomplete="off"
    />

    <p v-if="!shown.length" class="card p-10 text-center text-muted">
      {{ t("empty") }}
    </p>

    <ul v-else class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      <li v-for="a in shown" :key="a.icao">
        <a
          :href="`/airports/${a.icao}`"
          class="card flex h-full flex-col gap-1 p-3 transition hover:border-can/40"
        >
          <span class="flex items-baseline gap-2">
            <span class="font-mono text-base font-semibold text-ink">{{
              a.icao
            }}</span>
            <span class="text-xs text-faint">{{ a.fir }}</span>
          </span>
          <span class="tnum text-xs text-muted">
            {{ a.lat.toFixed(3) }}, {{ a.lon.toFixed(3) }}
            <template v-if="a.elev !== null"> · {{ a.elev }} ft</template>
          </span>
        </a>
      </li>
    </ul>
  </div>
</template>
