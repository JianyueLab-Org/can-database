<script setup lang="ts">
/**
 * 一张表旁边的导出按钮。
 *
 * **它不渲染表格。** 七张表里三张（跑道、机位、数据集）是 Astro 直出的 HTML，为了
 * 导出把它们改写成 Vue 是把渲染搬到运行时去换一个按钮，不值得 —— 所以这个岛屿只接
 * 数据、只管出文件。
 *
 * 行数组因此会在那三节的 HTML 里出现两次（一次成表格，一次作 props）。都是单场或
 * 单页规模，可以接受；全库量级只出现在数据库里，不出现在任何一页上。
 */
import { computed, ref } from "vue";
import type { Licence } from "@/lib/canDb";
import { createTranslator } from "@/lib/i18n";
import { TABLES } from "@/lib/export/columns";
import { toCSV, toJSON, toGeoJSON, type Column } from "@/lib/export/serialize";
import { download, exportFilename } from "@/lib/export/download";

const props = defineProps<{
  /** TABLES 里的键。 */
  resource: string;
  /** 机场代号一类的限定，进文件名；没有就传 null。 */
  scope?: string | null;
  rows: unknown[];
  licence: Licence | null;
  /** getMessages 取来的整份字典，列名的 i18n 键在里面解。 */
  messages: Record<string, unknown>;
}>();

const t = createTranslator(props.messages);
const open = ref(false);
// TABLES[props.resource] is an internal contract between pages and this
// component; a resource with no entry must not throw on spec.value.columns.
const spec = computed(() => TABLES[props.resource]);

const columns = computed<Column<unknown>[]>(() =>
  spec.value.columns.map((c) => ({ header: t(c.headerKey), get: c.get })),
);

const formats = computed(() =>
  spec.value.geometry ? ["csv", "json", "geojson"] : ["csv", "json"],
);

function run(format: string) {
  open.value = false;
  const airac = props.licence?.airac ?? [];
  const name = (ext: string) =>
    exportFilename(props.resource, props.scope ?? null, airac, ext);

  if (format === "csv") {
    download(
      name("csv"),
      "text/csv;charset=utf-8",
      toCSV(props.rows, columns.value, props.licence),
    );
  } else if (format === "json") {
    download(
      name("json"),
      "application/json",
      toJSON(props.rows, props.licence),
    );
  } else {
    download(
      name("geojson"),
      "application/geo+json",
      toGeoJSON(props.rows, spec.value.geometry!, columns.value, props.licence),
    );
  }
}
</script>

<template>
  <div v-if="spec" class="relative inline-block">
    <button
      type="button"
      class="badge badge-neutral cursor-pointer"
      :disabled="rows.length === 0"
      @click="open = !open"
    >
      {{ t("export.button") }}
    </button>
    <ul
      v-if="open"
      class="card absolute right-0 z-10 mt-1 min-w-32 p-1 text-sm"
      role="menu"
    >
      <li v-for="f in formats" :key="f">
        <button
          type="button"
          class="w-full cursor-pointer px-3 py-1.5 text-left hover:bg-[var(--surface-hover)]"
          @click="run(f)"
        >
          {{ t(`export.${f}`) }}
        </button>
      </li>
    </ul>
  </div>
</template>
