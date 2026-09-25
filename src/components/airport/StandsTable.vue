<script setup lang="ts">
/**
 * 机场详情页的机位表。
 *
 * 原来是一面最多 60 个标签的墙，坐标和翼展藏在 `title` 里 —— 要核对一个机位得先在墙
 * 上找到它、再悬停，手机上悬停根本没有。ZGGG 有 520 个机位，读的人几乎总是在找**某一
 * 个**（「213 号在不在它该在的地方」），所以这一节按〈清单页的两条规矩〉来：有搜索框，
 * 截断要说出来。
 *
 * **默认只渲染前 `CAP` 个**，理由和航路点页那条上限一样：五百多行每行四格是两千多个节
 * 点，而一屏能看见的不到二十行。省略掉的数量写在表下，并给一个「全部显示」——
 * 一个悄悄截断的列表会让人以为剩下的不存在。搜索时上限作用在**匹配结果**上。
 *
 * 数据在 SSR 那一份里已经有了，这里只做即时过滤，不另取。
 *
 * 页面上的 `/` 归程序搜索（那是这一页更常用的清单），这里不抢热键。
 */
import { computed, ref } from "vue";
import { EmptyState } from "@jianyuelab-org/can-ui";
import SearchField from "@/components/ui/SearchField.vue";
import { useQueryState } from "@/composables/useQueryState";
import { createTranslator } from "@/lib/i18n";
import type { Stand } from "@/lib/canDb";

const props = defineProps<{
  messages: Record<string, unknown>;
  stands: Stand[];
}>();
const t = createTranslator(props.messages);

const CAP = 60;

const query = useQueryState("stand");
const showAll = ref(false);

const matched = computed(() => {
  const needle = query.value.trim().toUpperCase();
  if (!needle) return props.stands;
  return props.stands.filter((s) => s.name.toUpperCase().includes(needle));
});

const shown = computed(() =>
  showAll.value ? matched.value : matched.value.slice(0, CAP),
);
const hidden = computed(() => matched.value.length - shown.value.length);
</script>

<template>
  <div class="flex flex-col gap-3">
    <EmptyState
      v-if="!stands.length"
      compact
      :title="t('none')"
      icon="mapPin"
    />

    <template v-else>
      <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div class="min-w-48 flex-1 sm:max-w-xs">
          <SearchField
            v-model="query"
            :label="t('search')"
            :placeholder="t('searchHint')"
            :hotkey="null"
            uppercase
          />
        </div>
        <p class="tnum text-xs text-faint" aria-live="polite">
          {{
            query
              ? t("showing", {
                  n: String(matched.length),
                  total: String(stands.length),
                })
              : t("total", { n: String(stands.length) })
          }}
        </p>
      </div>

      <EmptyState
        v-if="!matched.length"
        compact
        icon="magnifyingGlass"
        :title="t('noMatch', { q: query })"
      >
        <template #action>
          <button type="button" class="btn btn-soft" @click="query = ''">
            {{ t("clear") }}
          </button>
        </template>
      </EmptyState>

      <div
        v-else
        class="scroll-shadow-x overflow-x-auto"
        style="--scroll-shadow-bg: var(--surface)"
      >
        <table class="data-table w-full text-sm">
          <thead>
            <tr>
              <th>{{ t("name") }}</th>
              <th class="text-right">{{ t("hdg") }}</th>
              <th class="text-right">{{ t("span") }}</th>
              <th class="text-right">{{ t("coords") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(s, i) in shown" :key="`${s.name}-${i}`">
              <td
                :data-label="t('name')"
                class="font-mono font-medium text-ink"
              >
                {{ s.name }}
              </td>
              <td :data-label="t('hdg')" class="tnum text-right">
                {{ s.hdg ?? "—" }}
              </td>
              <!-- span 缺失印破折号，不印 0：0 米翼展的意思是「装不下任何东西」，和
                   「不知道」正相反。 -->
              <td :data-label="t('span')" class="tnum text-right">
                {{ s.span ?? "—" }}
              </td>
              <td
                :data-label="t('coords')"
                class="tnum text-right text-xs text-muted"
              >
                {{ s.lat.toFixed(5) }}, {{ s.lon.toFixed(5) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div
        v-if="hidden > 0 || (showAll && matched.length > CAP)"
        class="flex flex-wrap items-center gap-3 text-xs text-faint"
      >
        <span v-if="hidden > 0" class="tnum">
          {{ t("truncated", { n: String(CAP), rest: String(hidden) }) }}
        </span>
        <button
          type="button"
          class="btn btn-secondary"
          @click="showAll = !showAll"
        >
          {{
            showAll
              ? t("showFewer")
              : t("showAll", { n: String(matched.length) })
          }}
        </button>
      </div>
    </template>
  </div>
</template>
