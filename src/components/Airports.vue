<script setup lang="ts">
/**
 * 机场清单：一个即时过滤框 + 一排 FIR 筛选。
 *
 * 岛屿而不是服务端渲染，因为这一页唯一的操作就是「找那个机场」，而 233 行里翻找不如
 * 敲四个字母。清单整份随页面下来（每条六个字段，比图标精灵图还小），所以过滤是本地
 * 的 —— 每敲一个键往返一次服务器是这一页最容易犯的错。
 *
 * ## FIR 的颜色和地图是同一套
 *
 * 色块取自 `@/lib/mapBase` 的 `firColor`，和 /map 上那张图逐字同源。一个成员在清单上
 * 认得的 ZGZU 的颜色，点进地图应该还是那一个 —— 两处各写一份配色，漂移只是时间问题。
 */
import { computed, ref } from "vue";
import { createTranslator } from "@/lib/i18n";
import { firColor } from "@/lib/mapBase";
import type { AirportSummary } from "@/lib/canDb";

const props = defineProps<{
  messages: Record<string, unknown>;
  airports: AirportSummary[];
}>();
const t = createTranslator(props.messages);

const query = ref("");
/** null = 不限 FIR。 */
const activeFir = ref<string | null>(null);

/** FIR 及其机场数，按机场数降序 —— 大的在前，找起来快。 */
const firs = computed(() => {
  const counts = new Map<string, number>();
  for (const a of props.airports) {
    if (a.fir) counts.set(a.fir, (counts.get(a.fir) ?? 0) + 1);
  }
  return [...counts.entries()].sort((x, y) => y[1] - x[1]);
});

const shown = computed(() => {
  const needle = query.value.trim().toUpperCase();
  return props.airports.filter((a) => {
    if (activeFir.value && a.fir !== activeFir.value) return false;
    if (!needle) return true;
    return (
      a.icao.includes(needle) ||
      (a.fir ?? "").includes(needle) ||
      (a.name ?? "").toUpperCase().includes(needle)
    );
  });
});

function pickFir(fir: string) {
  activeFir.value = activeFir.value === fir ? null : fir;
}
</script>

<template>
  <div>
    <div class="mb-4 flex flex-wrap items-center gap-3">
      <label class="sr-only" for="airport-search">{{ t("search") }}</label>
      <input
        id="airport-search"
        v-model="query"
        type="search"
        class="input w-full max-w-xs"
        :placeholder="t('search')"
        autocomplete="off"
      />
      <a href="/map" class="link text-sm">{{ t("onMap") }} →</a>
    </div>

    <div class="mb-4 flex flex-wrap items-center gap-1.5">
      <button
        v-for="[fir, n] in firs"
        :key="fir"
        type="button"
        class="flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition"
        :class="
          activeFir === fir
            ? 'border-can bg-can/10 text-ink'
            : 'border-line text-muted hover:border-can/40'
        "
        @click="pickFir(fir)"
      >
        <span
          class="inline-block size-2 rounded-full"
          :style="{ backgroundColor: firColor(fir) }"
          aria-hidden="true"
        />
        <span class="font-mono">{{ fir }}</span>
        <span class="tnum opacity-60">{{ n }}</span>
      </button>
    </div>

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
            <span
              class="inline-block size-2 shrink-0 rounded-full"
              :style="{ backgroundColor: firColor(a.fir) }"
              aria-hidden="true"
            />
            <span class="font-mono text-base font-semibold text-ink">{{
              a.icao
            }}</span>
            <span class="text-xs text-faint">{{ a.fir }}</span>
          </span>

          <span v-if="a.name" class="truncate text-xs text-muted">{{
            a.name
          }}</span>

          <span class="tnum text-xs text-faint">
            {{ a.lat.toFixed(3) }}, {{ a.lon.toFixed(3) }}
            <template v-if="a.elev !== null"> · {{ a.elev }} ft</template>
            <!-- 机位数本来就在这条响应里（can-db 的 AirportIndex 带着它），
                 从前被类型丢掉了。它是「这个场的数据全不全」最直接的一眼。 -->
            <template v-if="a.stands">
              · {{ t("stands", { n: String(a.stands) }) }}</template
            >
          </span>
        </a>
      </li>
    </ul>

    <p class="mt-4 text-xs text-faint">
      {{
        t("shownCount", {
          n: String(shown.length),
          total: String(airports.length),
        })
      }}
    </p>
  </div>
</template>
