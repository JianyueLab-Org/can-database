<script setup lang="ts">
/**
 * 总览页的「直达机场」：敲一个 ICAO，回车就进 `/airports/<ICAO>`。
 *
 * 来总览页的人多半是要看某一个机场的，所以这是这一页的主操作，`/` 把焦点送进来。
 *
 * **这里只查格式，不查存不存在。** 「库里有没有这个机场」是 can-db 的答案 —— 详情页取
 * 不到会渲染 404，这里再取一遍机场清单只为了提前说一句，等于每次打开总览多下一份索引。
 */
import { ref } from "vue";
import SearchField from "@/components/ui/SearchField.vue";
import { createTranslator } from "@/lib/i18n";

const props = defineProps<{ messages: Record<string, unknown> }>();
const t = createTranslator(props.messages);

const query = ref("");
const invalid = ref(false);

const ICAO = /^[A-Z]{4}$/;

function go() {
  const icao = query.value.trim().toUpperCase();
  if (!ICAO.test(icao)) {
    invalid.value = true;
    return;
  }
  invalid.value = false;
  window.location.href = `/airports/${icao}`;
}

function onInput(value: string) {
  query.value = value;
  // 打字时不喊错，只在提交之后、而且改对了就收回。
  if (invalid.value && (value === "" || ICAO.test(value.trim())))
    invalid.value = false;
}
</script>

<template>
  <form class="flex flex-col gap-2" novalidate @submit.prevent="go">
    <div class="flex gap-2">
      <SearchField
        :model-value="query"
        :label="t('jumpLabel')"
        :placeholder="t('jumpPlaceholder')"
        uppercase
        @update:model-value="onInput"
        @submit="go"
      />
      <button type="submit" class="btn btn-primary shrink-0">
        {{ t("jumpGo") }}
      </button>
    </div>
    <p
      class="text-xs"
      :class="invalid ? 'text-danger' : 'text-faint'"
      :role="invalid ? 'alert' : undefined"
    >
      {{ invalid ? t("jumpInvalid") : t("jumpHint") }}
    </p>
  </form>
</template>
