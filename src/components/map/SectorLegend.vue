<script setup lang="ts">
/**
 * 扇区图层的图例：三种状态，三个色块。
 *
 * **色块走 `sectorPaint`，不在这里另写一套颜色。** 图例和地图各配一次色，改了一处另一处
 * 就在说谎 —— 而这张图上「没人管」是最需要可信的那个状态。示例用的归属对象只是为了让
 * `sectorPaint` 走到对应的分支，不是真数据。
 */
import { computed } from "vue";
import type { SectorOwnership } from "@/lib/canDb";
import { sectorPaint, type SectorPaint } from "@/lib/sectorMap";

const props = defineProps<{
  /** 「没解析过」那一格用的包色 —— 选了 FIR 就是那个 FIR 的颜色。 */
  packageColor: string;
  labels: {
    unresolved: string;
    owned: string;
    uncovered: string;
  };
}>();

const SAMPLE_OWNED: SectorOwnership = {
  id: 0,
  name: "",
  package: "",
  owner: "ZBAA_CTR",
  rank: 0,
  uncovered: false,
};
const SAMPLE_UNCOVERED: SectorOwnership = {
  ...SAMPLE_OWNED,
  owner: null,
  rank: null,
  uncovered: true,
};

function swatch(p: SectorPaint) {
  return {
    border: `1.5px ${p.dashArray ? "dashed" : "solid"} ${p.color}`,
    // 填充按图上的透明度画。小色块上 6% 很淡，但那正是图上的样子。
    background: p.fillOpacity
      ? `color-mix(in srgb, ${p.fillColor ?? p.color} ${Math.round(p.fillOpacity * 100)}%, transparent)`
      : "transparent",
  };
}

const rows = computed(() => [
  {
    key: "unresolved",
    label: props.labels.unresolved,
    style: swatch(sectorPaint(null, props.packageColor)),
  },
  {
    key: "owned",
    label: props.labels.owned,
    style: swatch(sectorPaint(SAMPLE_OWNED, props.packageColor)),
  },
  {
    key: "uncovered",
    label: props.labels.uncovered,
    style: swatch(sectorPaint(SAMPLE_UNCOVERED, props.packageColor)),
  },
]);
</script>

<template>
  <ul class="space-y-1.5 text-xs text-muted">
    <li v-for="r in rows" :key="r.key" class="flex items-start gap-2">
      <span
        class="mt-0.5 inline-block h-3 w-4 shrink-0 rounded-[3px]"
        :style="r.style"
        aria-hidden="true"
      />
      <span class="min-w-0">{{ r.label }}</span>
    </li>
  </ul>
</template>
