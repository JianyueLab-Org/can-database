<script setup lang="ts">
/**
 * 数据编辑器左栏：登记表里的表，按父子关系排成一棵树，顶上一个搜索框。
 *
 * 树完全照登记表长：`parent` 指向谁就挂在谁下面，标了 `onAirport` 的表挂在 `airport`
 * 下面（它们按 `icao` 随机场级联，和子表是同一种从属）。顺序是登记表的顺序 —— 那是
 * can-db 的克隆顺序，父表永远在子表前面，这里不重排。
 *
 * 搜索时改成平铺：只剩几条的时候缩进没有意义，旁边写上它挂在谁下面。Enter 在只剩一
 * 张表时直接选中它。
 */
import { computed, ref } from "vue";
import type { TableSpec } from "@/lib/canDb";
import type { Translator } from "@/lib/i18n";
import SearchField from "@/components/ui/SearchField.vue";

const props = defineProps<{
  tables: TableSpec[];
  current: string;
  t: Translator;
}>();
const emit = defineEmits<{ pick: [name: string] }>();

const query = ref("");

interface Node {
  spec: TableSpec;
  depth: number;
  /** 挂在哪张表下面；根表为空串。 */
  under: string;
}

function upOf(spec: TableSpec): string {
  if (spec.parent) return spec.parent.table;
  if (spec.onAirport) return "airport";
  return "";
}

const tree = computed<Node[]>(() => {
  const names = new Set(props.tables.map((s) => s.name));
  const children = new Map<string, TableSpec[]>();
  const roots: TableSpec[] = [];
  for (const spec of props.tables) {
    const up = upOf(spec);
    // 父表不在登记表里时当根表放，不让它从清单上消失。
    if (up && names.has(up) && up !== spec.name) {
      children.set(up, [...(children.get(up) ?? []), spec]);
    } else {
      roots.push(spec);
    }
  }
  const out: Node[] = [];
  const seen = new Set<string>();
  const walk = (spec: TableSpec, depth: number, under: string) => {
    if (seen.has(spec.name)) return;
    seen.add(spec.name);
    out.push({ spec, depth, under });
    for (const child of children.get(spec.name) ?? [])
      walk(child, depth + 1, spec.name);
  };
  for (const root of roots) walk(root, 0, "");
  return out;
});

const shown = computed(() => {
  const needle = query.value.trim().toLowerCase();
  if (!needle) return tree.value;
  return tree.value.filter((node) => node.spec.name.includes(needle));
});

function onSubmit() {
  const only = shown.value.length === 1 ? shown.value[0] : null;
  if (only) emit("pick", only.spec.name);
}
</script>

<template>
  <nav :aria-label="t('table')" class="space-y-2">
    <SearchField
      v-model="query"
      :label="t('tableSearch')"
      :placeholder="t('tableSearch')"
      @submit="onSubmit"
    />
    <p
      v-if="!shown.length"
      class="px-2 py-4 text-center text-sm text-muted"
      role="status"
    >
      {{ t("noTables") }}
    </p>
    <ul v-else class="space-y-px">
      <li v-for="node in shown" :key="node.spec.name">
        <button
          type="button"
          :aria-current="node.spec.name === current ? 'page' : undefined"
          :class="[
            'flex w-full items-center gap-1.5 rounded-control py-1.5 pr-2 text-left font-mono text-[0.8125rem] transition-colors focus-visible:outline-2 focus-visible:outline-can',
            node.spec.name === current
              ? 'bg-surface-sunken font-semibold text-ink'
              : 'text-muted hover:bg-surface-sunken hover:text-ink',
          ]"
          :style="{
            paddingLeft: `${0.5 + (query ? 0 : node.depth) * 0.875}rem`,
          }"
          @click="emit('pick', node.spec.name)"
        >
          <span
            v-if="node.depth && !query"
            class="text-faint"
            aria-hidden="true"
            >└</span
          >
          <span class="min-w-0 flex-1 truncate">{{ node.spec.name }}</span>
          <span
            v-if="query && node.under"
            class="truncate text-xs text-faint"
            >{{ node.under }}</span
          >
        </button>
      </li>
    </ul>
  </nav>
</template>
