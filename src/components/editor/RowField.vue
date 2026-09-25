<script setup lang="ts">
/**
 * 行表单里的一个字段，控件按登记表的列类型选：布尔和带取值表的列是下拉，`double[]`
 * 是多行文本，其余是单行输入。值一律是字符串，变成 JSON 值是 `DataEditor` 提交时的事。
 *
 * 错误标在这一列自己下面 —— can-db 违反约束时回的 `column`，或者本地认不出的数字。
 * 锁定的列（修改时的父列、自动生成的列）照样显示值，只是不能改，并且写明为什么。
 */
import { computed } from "vue";
import type { TableColumn } from "@/lib/canDb";
import type { Translator } from "@/lib/i18n";

const props = defineProps<{
  col: TableColumn;
  modelValue: string;
  mode: "add" | "edit";
  isKey: boolean;
  /** 修改时的父列。 */
  locked: boolean;
  /** 修改时值和原来不一样。 */
  changed: boolean;
  error: string;
  t: Translator;
}>();
const emit = defineEmits<{ "update:modelValue": [value: string] }>();

const id = computed(() => `field-${props.col.name}`);
const errorId = computed(() => `field-${props.col.name}-error`);
const numeric = computed(() =>
  ["integer", "smallint", "bigint", "double"].includes(props.col.type),
);
const required = computed(
  () => props.mode === "add" && !props.col.nullable && !props.col.hasDefault,
);
const readOnly = computed(() => props.col.identity || props.locked);
const emptyLabel = computed(() =>
  props.mode === "add" && props.col.hasDefault
    ? props.t("defaultValue")
    : props.t("nullValue"),
);

function update(event: Event) {
  emit(
    "update:modelValue",
    (event.target as HTMLInputElement | HTMLSelectElement).value,
  );
}

const control = computed(() => [
  "input w-full",
  props.isKey || numeric.value || props.col.values?.length ? "font-mono" : "",
  props.error ? "input-error" : "",
]);
</script>

<template>
  <div>
    <label
      class="mb-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs"
      :for="id"
    >
      <span class="font-mono font-semibold text-ink">{{ col.name }}</span>
      <span class="text-faint">{{ col.type }}</span>
      <span v-if="isKey" class="badge badge-info">{{ t("keyColumn") }}</span>
      <span v-if="required" class="badge badge-warning">{{
        t("required")
      }}</span>
      <span v-if="col.identity" class="badge badge-neutral">{{
        t("generated")
      }}</span>
      <span v-else-if="locked" class="badge badge-neutral">{{
        t("locked")
      }}</span>
      <span
        v-if="changed"
        class="ml-auto inline-flex items-center gap-1 text-can"
      >
        <span class="size-1.5 rounded-full bg-current" aria-hidden="true" />
        {{ t("changed") }}
      </span>
    </label>

    <input
      v-if="readOnly"
      :id="id"
      :value="mode === 'add' && col.identity ? '' : modelValue"
      :placeholder="col.identity ? t('generated') : undefined"
      class="input w-full cursor-not-allowed bg-surface-sunken font-mono text-muted"
      readonly
      aria-readonly="true"
      :aria-describedby="locked ? `${id}-lock` : undefined"
    />
    <select
      v-else-if="col.type === 'boolean'"
      :id="id"
      :value="modelValue"
      :class="control"
      :aria-invalid="error ? true : undefined"
      :aria-describedby="error ? errorId : undefined"
      @change="update"
    >
      <option value="">{{ emptyLabel }}</option>
      <option value="true">{{ t("true") }}</option>
      <option value="false">{{ t("false") }}</option>
    </select>
    <select
      v-else-if="col.values?.length"
      :id="id"
      :value="modelValue"
      :class="control"
      :aria-invalid="error ? true : undefined"
      :aria-describedby="error ? errorId : undefined"
      @change="update"
    >
      <option value="">{{ emptyLabel }}</option>
      <option v-for="v in col.values" :key="v" :value="v">{{ v }}</option>
    </select>
    <textarea
      v-else-if="col.type === 'double[]'"
      :id="id"
      :value="modelValue"
      rows="3"
      :placeholder="t('arrayHint')"
      :class="[...control, 'text-xs']"
      :aria-invalid="error ? true : undefined"
      :aria-describedby="error ? errorId : undefined"
      @input="update"
    />
    <input
      v-else
      :id="id"
      :value="modelValue"
      :inputmode="numeric ? 'decimal' : undefined"
      :placeholder="
        mode === 'add' && col.hasDefault ? t('defaultValue') : undefined
      "
      :required="required"
      autocomplete="off"
      spellcheck="false"
      :class="control"
      :aria-invalid="error ? true : undefined"
      :aria-describedby="error ? errorId : undefined"
      @input="update"
    />

    <p v-if="locked" :id="`${id}-lock`" class="mt-1 text-xs text-faint">
      {{ t("lockedHint") }}
    </p>
    <p v-if="error" :id="errorId" class="mt-1 text-xs text-danger" role="alert">
      {{ error }}
    </p>
  </div>
</template>
