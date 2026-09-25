<script setup lang="ts">
/**
 * 一排单选筛子（FIR、类别、跑道）。再点一次已选中的那一个等于取消。
 *
 * 带色点时颜色由调用方给 —— FIR 的颜色必须来自 `firColor`，和地图同源。
 * 第一格是「全部」，它是否被选中就是「当前有没有筛」，一眼看得见。
 */
export interface Chip {
  value: string;
  label: string;
  count?: number;
  color?: string;
  mono?: boolean;
  disabled?: boolean;
}

const props = defineProps<{
  modelValue: string;
  chips: Chip[];
  /** 「全部」那一格的文字；不给就不画那一格。 */
  allLabel?: string;
  allCount?: number;
  label: string;
}>();

const emit = defineEmits<{ "update:modelValue": [string] }>();

function pick(value: string) {
  emit("update:modelValue", props.modelValue === value ? "" : value);
}
</script>

<template>
  <div
    class="flex flex-wrap items-center gap-1.5"
    role="group"
    :aria-label="label"
  >
    <button
      v-if="allLabel"
      type="button"
      class="chip"
      :aria-pressed="!modelValue"
      @click="emit('update:modelValue', '')"
    >
      {{ allLabel }}
      <span v-if="allCount !== undefined" class="chip__count">{{
        allCount
      }}</span>
    </button>
    <button
      v-for="c in chips"
      :key="c.value"
      type="button"
      class="chip"
      :aria-pressed="modelValue === c.value"
      :disabled="c.disabled"
      @click="pick(c.value)"
    >
      <span
        v-if="c.color"
        class="chip__dot"
        :style="{ backgroundColor: c.color }"
        aria-hidden="true"
      />
      <span :class="{ 'font-mono': c.mono }">{{ c.label }}</span>
      <span v-if="c.count !== undefined" class="chip__count">{{
        c.count
      }}</span>
    </button>
  </div>
</template>
