<script setup lang="ts">
/**
 * 三个清单页（机场、航路点、席位）共用的筛选条外框：搜索框在左、导出在右，筛子一排排
 * 放在下面，最后一行是条数。
 *
 * 只管排版，不管状态 —— 每一页的筛子含义不同（航路点的 FIR 是「必须先选」，机场的是
 * 「可选的收窄」），状态留在各自的岛屿里。三页长得一样，是为了让人换页之后不用重新找
 * 搜索框在哪。
 */
</script>

<template>
  <div class="mb-4 flex flex-col gap-3">
    <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div class="min-w-0 flex-1 basis-64 sm:max-w-md">
        <slot name="search" />
      </div>
      <div class="ml-auto flex items-center gap-4">
        <slot name="actions" />
      </div>
    </div>
    <slot name="filters" />
    <p
      v-if="$slots.count"
      class="tnum flex flex-wrap items-center gap-x-3 text-xs text-faint"
      aria-live="polite"
    >
      <slot name="count" />
    </p>
  </div>
</template>
