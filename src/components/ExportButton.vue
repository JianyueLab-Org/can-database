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
 *
 * 外观是一个小号的次要按钮，点开是 can-ui 的 `Popover` 格式菜单：菜单头写着要导出几
 * 行 —— 列表页的导出跟随筛选，按下去之前该看得到「导的是筛过的那几行」。
 */
import { computed } from "vue";
import { Icon, Popover } from "@jianyuelab-org/can-ui";
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
      toGeoJSON(props.rows, spec.value.geometry!, props.licence),
    );
  }
}
</script>

<template>
  <Popover
    v-if="spec"
    placement="bottom-end"
    width="13rem"
    :label="t('export.button')"
  >
    <template #trigger="{ toggle, open }">
      <button
        type="button"
        class="btn btn-secondary h-8 gap-1.5 px-2.5 text-xs"
        :disabled="rows.length === 0"
        :aria-expanded="open"
        aria-haspopup="menu"
        @click="toggle"
      >
        <Icon name="arrowDownTray" class="size-4" />
        {{ t("export.button") }}
        <Icon
          name="chevronDown"
          class="size-3.5 transition-transform"
          :class="open ? 'rotate-180' : ''"
        />
      </button>
    </template>

    <template #default="{ close }">
      <p class="tnum px-2.5 pt-1.5 pb-1 text-xs text-faint">
        {{ t("export.rows", { n: rows.length }) }}
      </p>
      <ul role="menu" class="space-y-0.5">
        <li v-for="f in formats" :key="f" role="none">
          <button
            type="button"
            role="menuitem"
            class="flex w-full items-center gap-2.5 rounded-control px-2.5 py-2 text-left text-sm text-ink transition-colors hover:bg-surface-raised focus-visible:bg-surface-raised focus-visible:outline-none"
            @click="
              close();
              run(f);
            "
          >
            <Icon name="documentText" class="size-4 shrink-0 text-faint" />
            {{ t(`export.${f}`) }}
          </button>
        </li>
      </ul>
    </template>
  </Popover>
</template>
