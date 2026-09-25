<script setup lang="ts">
/**
 * 清单页的搜索框 —— 那几页的主操作，所以它有自己的组件。
 *
 * - 左边放大镜，右边一个清除按钮（有内容时才出现）。
 * - `hotkey`（默认 `/`）在页面任何地方把焦点送进来，输入框、文本框里按不算。
 * - Esc：有内容先清空，空了再失焦。
 * - Enter 发 `submit`，页面用它做「只剩一条就直接打开」。
 */
import { onBeforeUnmount, onMounted, ref, useId } from "vue";
import { Icon } from "@jianyuelab-org/can-ui";

const props = withDefaults(
  defineProps<{
    modelValue: string;
    placeholder?: string;
    label: string;
    hotkey?: string | null;
    id?: string;
    /** 代号类输入（ICAO、航路点）自动转大写。 */
    uppercase?: boolean;
    /** 清除按钮的无障碍名称；不给就按页面语言取「清除」。 */
    clearLabel?: string;
  }>(),
  { hotkey: "/", uppercase: false },
);

const emit = defineEmits<{
  "update:modelValue": [string];
  submit: [];
}>();

const input = ref<HTMLInputElement | null>(null);

/** 清除按钮只在有内容时出现，而内容只在客户端才有，所以这里读 `document` 是安全的。 */
const CLEAR: Record<string, string> = {
  "zh-cn": "清除",
  "zh-tw": "清除",
  "en-us": "Clear",
  "ja-jp": "クリア",
};
function clearText() {
  if (props.clearLabel) return props.clearLabel;
  const lang =
    typeof document === "undefined" ? "" : document.documentElement.lang;
  return CLEAR[lang] ?? CLEAR["zh-cn"];
}
const inputId = props.id ?? useId();

function onInput(event: Event) {
  const raw = (event.target as HTMLInputElement).value;
  emit("update:modelValue", props.uppercase ? raw.toUpperCase() : raw);
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape") {
    if (props.modelValue) emit("update:modelValue", "");
    else input.value?.blur();
  } else if (event.key === "Enter") {
    event.preventDefault();
    emit("submit");
  }
}

function clear() {
  emit("update:modelValue", "");
  input.value?.focus();
}

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return (
    el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName)
  );
}

function onGlobalKeydown(event: KeyboardEvent) {
  if (!props.hotkey || event.key !== props.hotkey) return;
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  if (isTyping(event.target)) return;
  event.preventDefault();
  input.value?.focus();
  input.value?.select();
}

onMounted(() => document.addEventListener("keydown", onGlobalKeydown));
onBeforeUnmount(() => document.removeEventListener("keydown", onGlobalKeydown));

defineExpose({ focus: () => input.value?.focus() });
</script>

<template>
  <div class="relative w-full">
    <label class="sr-only" :for="inputId">{{ label }}</label>
    <Icon
      name="magnifyingGlass"
      class="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint"
    />
    <input
      :id="inputId"
      ref="input"
      :value="modelValue"
      type="search"
      class="input search-field w-full pr-16 pl-9"
      :class="{ 'font-mono': uppercase && modelValue }"
      :placeholder="placeholder ?? label"
      autocomplete="off"
      spellcheck="false"
      enterkeyhint="search"
      @input="onInput"
      @keydown="onKeydown"
    />
    <div
      class="absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1"
    >
      <button
        v-if="modelValue"
        type="button"
        class="icon-button size-7 text-faint hover:text-ink"
        :aria-label="clearText()"
        @click="clear"
      >
        <Icon name="xMark" class="size-4" />
      </button>
      <kbd v-else-if="hotkey" class="kbd hidden sm:inline-flex">{{
        hotkey
      }}</kbd>
    </div>
  </div>
</template>

<style scoped>
/* 自己画了清除按钮，浏览器自带的那个叉就多余了。 */
.search-field::-webkit-search-cancel-button {
  appearance: none;
}
</style>
