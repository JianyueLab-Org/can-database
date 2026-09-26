<script setup lang="ts">
/**
 * 按 FIR 浏览航路点。
 *
 * **必须先选 FIR，这不是分页。** 一个代号只在一个 FIR 内唯一：2608 的包里有 267 个代号
 * 指向不止一个物理点 —— `AKAGI` 在 RJJJ 和 ZLHW 各有一个，相距 3863 公里。一份按代号排
 * 的全国清单会把它们并成一行，那不是「大」，是错。所以 can-db 的 `/aip/fixes` 没有 FIR
 * 参数就直接 400，这个岛屿的第一件事也是让人选 —— FIR 筛子没有「全部」那一格，没选的时
 * 候下面是一个提示，不是一张空表。
 *
 * FIR 和搜索词都挂在地址栏上（`?fir=`、`?q=`）：带着 `?fir=RJJJ` 打开这一页就直接载入
 * RJJJ，把「RJJJ 里的 AKAGI」发给别人是一条链接。
 *
 * ## 为什么有一个搜索框，和一个渲染上限
 *
 * RJJJ 有 3914 个航路点。**打开这一页的人几乎总是在找某一个代号**，而原来这里只有一个
 * 滚动框 —— 找 `AKAGI` 的办法是用眼睛扫三千行，或者按浏览器的 Ctrl+F 去搜一份已经渲染
 * 出来的 DOM。搜索框才是这一页的主操作。
 *
 * 上限是第二件事：三千多行表格是一万多个节点，而其中能看见的不到三十个。所以只渲染前
 * `RENDER_CAP` 条，并且**把省略掉的数量说出来** —— 一个悄悄截断的列表会让人以为剩下的
 * 不存在，那比慢更糟。
 */
import { computed, ref, watch } from "vue";
import { AlertBox, EmptyState, Skeleton } from "@jianyuelab-org/can-ui";
import { createTranslator } from "@/lib/i18n";
import { firColor } from "@/lib/mapBase";
import { api, type Fix, type Licence } from "@/lib/canDb";
import { fixRowKey } from "@/lib/viewport";
import { useQueryState } from "@/composables/useQueryState";
import ExportButton from "@/components/ExportButton.vue";
import SearchField from "@/components/ui/SearchField.vue";
import FilterChips from "@/components/ui/FilterChips.vue";
import ListToolbar from "@/components/lists/ListToolbar.vue";

const props = defineProps<{
  messages: Record<string, unknown>;
  firs: string[];
  licence: Licence | null;
  exportMessages: Record<string, unknown>;
}>();
const t = createTranslator(props.messages);

/** 一次最多渲染多少行。见文件头 —— 超出的部分由搜索框收敛，不是分页。 */
const RENDER_CAP = 300;

const fir = useQueryState("fir");
const query = useQueryState("q");
const fixes = ref<Fix[]>([]);
const loading = ref(false);
const error = ref("");
/** 最近一次请求的序号 —— 来回切 FIR 时，先发后到的那份不能盖掉后选的。 */
let latest = 0;

const firChips = computed(() =>
  props.firs.map((f) => ({
    value: f,
    label: f,
    color: firColor(f),
    mono: true,
  })),
);

watch(fir, async (value, previous) => {
  fixes.value = [];
  error.value = "";
  // 换 FIR 才清搜索词。从地址栏带进来的 `?fir=&q=` 是同一次打开，词要留着。
  if (previous) query.value = "";
  if (!value) {
    loading.value = false;
    return;
  }

  const seq = ++latest;
  loading.value = true;
  const result = await api<Fix[]>(
    `/api/v1/aip/fixes?fir=${encodeURIComponent(value)}`,
  );
  if (seq !== latest) return;
  loading.value = false;

  if (!result.ok) {
    error.value = result.message;
    return;
  }
  fixes.value = result.data ?? [];
});

const matched = computed(() => {
  const needle = query.value.trim().toUpperCase();
  if (!needle) return fixes.value;
  return fixes.value.filter((f) => f.ident.toUpperCase().includes(needle));
});

const shown = computed(() => matched.value.slice(0, RENDER_CAP));
const hidden = computed(() =>
  Math.max(0, matched.value.length - shown.value.length),
);

const ready = computed(
  () => !!fir.value && !loading.value && !error.value && !!fixes.value.length,
);
</script>

<template>
  <div>
    <ListToolbar>
      <template #search>
        <SearchField
          v-model="query"
          :label="t('search')"
          uppercase
          :hotkey="fir ? '/' : null"
        />
      </template>
      <template #actions>
        <a
          v-if="fir"
          :href="`/map?fir=${encodeURIComponent(fir)}`"
          class="link text-sm whitespace-nowrap"
        >
          {{ t("onMap") }} →
        </a>
        <!-- 导出跟随筛选之后、渲染上限（RENDER_CAP）之前的那份，也就是 matched
             本身，不是 shown。 -->
        <ExportButton
          resource="fixes"
          :scope="fir || null"
          :rows="matched"
          :licence="licence"
          :messages="exportMessages"
        />
      </template>
      <template #filters>
        <FilterChips v-model="fir" :chips="firChips" :label="t('pick')" />
      </template>
      <template v-if="ready" #count>
        <span
          class="inline-block size-2 rounded-full"
          :style="{ backgroundColor: firColor(fir) }"
          aria-hidden="true"
        />
        <span v-if="query.trim()">{{
          t("matched", {
            n: String(matched.length),
            total: String(fixes.length),
          })
        }}</span>
        <span v-else>{{ t("count", { count: String(fixes.length) }) }}</span>
      </template>
    </ListToolbar>

    <div v-if="!firs.length" class="card">
      <EmptyState :title="t('noFirs')" icon="signal" compact />
    </div>

    <div v-else-if="!fir" class="card">
      <EmptyState
        :title="t('pick')"
        :description="t('pickHint')"
        icon="funnel"
        compact
      />
    </div>

    <Skeleton v-else-if="loading" variant="table" :count="8" />

    <AlertBox v-else-if="error" variant="danger" :title="t('loadError')">
      {{ error }}
    </AlertBox>

    <div v-else-if="!fixes.length" class="card">
      <EmptyState :title="t('empty')" icon="signal" compact />
    </div>

    <div v-else-if="!matched.length" class="card">
      <EmptyState :title="t('noMatch')" icon="magnifyingGlass" compact>
        <template #action>
          <button type="button" class="btn btn-secondary" @click="query = ''">
            {{ t("clearSearch") }}
          </button>
        </template>
      </EmptyState>
    </div>

    <template v-else>
      <div class="scroll-shadow-x overflow-x-auto">
        <table class="data-table w-full text-sm">
          <thead>
            <tr>
              <th>{{ t("ident") }}</th>
              <th>{{ t("region") }}</th>
              <th>{{ t("pointKind") }}</th>
              <th class="text-right">{{ t("lat") }}</th>
              <th class="text-right">{{ t("lon") }}</th>
            </tr>
          </thead>
          <tbody>
            <!-- 代号不唯一：同一 FIR 里可以有 NAIP 一行和 Navigraph 区域里一行。key 带上区域、
                 种类和坐标。 -->
            <tr v-for="f in shown" :key="fixRowKey(f)">
              <td :data-label="t('ident')" class="font-mono font-semibold">
                {{ f.ident }}
              </td>
              <td :data-label="t('region')" class="font-mono text-xs">
                <span v-if="f.region">{{ f.region }}</span>
                <span v-else class="text-faint">—</span>
              </td>
              <td :data-label="t('pointKind')" class="text-xs text-muted">
                <span v-if="f.pointKind">{{ f.pointKind }}</span>
                <span v-else class="text-faint">—</span>
              </td>
              <td :data-label="t('lat')" class="tnum text-right text-muted">
                {{ f.lat.toFixed(4) }}
              </td>
              <td :data-label="t('lon')" class="tnum text-right text-muted">
                {{ f.lon.toFixed(4) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- 截断要说出来。一个悄悄截断的列表会让人以为剩下的不存在。 -->
      <p v-if="hidden" class="mt-3 text-xs text-faint">
        {{ t("truncated", { n: String(hidden) }) }}
      </p>
    </template>
  </div>
</template>
