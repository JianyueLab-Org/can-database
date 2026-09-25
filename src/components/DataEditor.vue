<script setup lang="ts">
/**
 * 一期数据的逐行编辑器。
 *
 * 表、列、类型、键和父子关系全部来自 can-db 的登记表（`GET /aip/tables`，页面 SSR 取好
 * 传进来）。这里不认识任何一张具体的表：表单按列类型生成，键按登记表的 `key` 拼进查询
 * 串，子表导航按 `parent` 走；登记表标了 `onAirport` 的表从一个机场跳过去，按 `icao`
 * 筛好。
 *
 * **校验在 can-db。** 这里只做把输入框里的字符串变成 JSON 值这一步（数字、布尔、数组），
 * 约束、非空、枚举、父行归属都由 can-db 判，错误原样显示在表单里 —— 违反约束时带约束名，
 * 能对上列名时标在那一列旁边。
 *
 * 状态写进地址栏（`?table=&列=值&offset=`），刷新和后退都回到同一处。
 *
 * 布局：桌面左栏是表的树（`editor/TablePicker.vue`），右栏是面包屑、筛选条和行表；手机
 * 上左栏收成一个按钮。新增和修改在右侧抽屉（can-ui `Drawer`）里做 —— 表格留在底下看得
 * 见，改的是哪一行不用靠记。删除走一个确认框。成功和失败都写在页内（`AlertBox`），不弹
 * 浏览器的 alert。
 */
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
} from "vue";
import {
  AlertBox,
  Dialog,
  Drawer,
  EmptyState,
  Icon,
  Popover,
  Skeleton,
} from "@jianyuelab-org/can-ui";
import { createTranslator } from "@/lib/i18n";
import {
  api,
  type Row,
  type RowPage,
  type RowValue,
  type TableColumn,
  type TableSpec,
} from "@/lib/canDb";
import TablePicker from "@/components/editor/TablePicker.vue";
import RowField from "@/components/editor/RowField.vue";

const props = defineProps<{
  datasetId: number;
  tables: TableSpec[];
  /** 从地址栏解出的初始状态（SSR 解好，免得水合前后不一致）。 */
  initial: { table: string; filter: Record<string, string>; offset: number };
  messages: Record<string, unknown>;
}>();
const t = createTranslator(props.messages);

const PAGE = 50;

const byName = computed(
  () => new Map(props.tables.map((spec) => [spec.name, spec])),
);

const tableName = ref(
  byName.value.has(props.initial.table) ? props.initial.table : "",
);
const filter = ref<Record<string, string>>({ ...props.initial.filter });
const offset = ref(props.initial.offset);
const draftFilter = reactive<Record<string, string>>({ ...filter.value });

const spec = computed(() => byName.value.get(tableName.value) ?? null);

/** 可筛选的列：父列（子表）加键列。 */
const filterColumns = computed(() => {
  const s = spec.value;
  if (!s) return [];
  const names = [...(s.parent ? [s.parent.column] : []), ...s.key];
  return [...new Set(names)];
});

const filtered = computed(() => Object.values(filter.value).some(Boolean));

/** 声明了父表是当前表的那些子表。 */
const childTables = computed(() =>
  props.tables.filter((c) => c.parent?.table === tableName.value),
);

/** 按 `icao` 挂在机场下面的表（登记表的 `onAirport`）。 */
const airportTables = computed(() =>
  tableName.value === "airport" ? props.tables.filter((c) => c.onAirport) : [],
);

interface Relation {
  table: string;
  filter: Record<string, string>;
}

function relationsOf(row: Row): Relation[] {
  const out: Relation[] = [];
  for (const child of childTables.value) {
    out.push({
      table: child.name,
      filter: { [child.parent!.column]: String(row.id ?? "") },
    });
  }
  for (const other of airportTables.value) {
    out.push({ table: other.name, filter: { icao: String(row.icao ?? "") } });
  }
  return out;
}

/* --------------------------------------------------------------- 面包屑 */

/**
 * 一张表按父列（或 `icao`）筛着的时候，它上面那一行在哪。
 * 子表按 `parent` 找回父表的 `id`；`onAirport` 的表按 `icao` 找回机场。
 */
function upOf(s: TableSpec, f: Record<string, string>): Relation | null {
  if (s.parent && f[s.parent.column]) {
    return { table: s.parent.table, filter: { id: f[s.parent.column]! } };
  }
  if (s.onAirport && f.icao && byName.value.has("airport")) {
    return { table: "airport", filter: { icao: f.icao } };
  }
  return null;
}

interface Crumb extends Relation {
  label: string;
}

/**
 * 从正在看的表往上，一层一层取父行，拼成「airport › ZBAA › procedure › … › 当前表」。
 * 父行要取回来才知道它自己的父列 —— 程序点的程序属于哪个机场，只有程序那一行知道。
 * 最多四层；取失败的那一层就用筛选值本身当名字，并停在那里。
 */
const trail = ref<Crumb[]>([]);
let trailRequest = 0;

async function buildTrail() {
  const ticket = ++trailRequest;
  const out: Crumb[] = [];
  let s = spec.value;
  let f = filter.value;
  for (let depth = 0; s && depth < 4; depth++) {
    const up = upOf(s, f);
    if (!up) break;
    const upSpec = byName.value.get(up.table);
    if (!upSpec) break;
    const upTable = up.table;
    const query = new URLSearchParams({ ...up.filter, limit: "1" });
    const result = await api<RowPage>(
      `/api/v1/aip/datasets/${props.datasetId}/tables/${upTable}/rows?${query}`,
    );
    if (ticket !== trailRequest) return;
    const row = result.ok ? result.data.rows[0] : undefined;
    out.unshift({
      ...up,
      label: row ? rowLabel(upSpec, row) : Object.values(up.filter).join(" · "),
    });
    if (!row) break;
    s = upSpec;
    f = Object.fromEntries(
      Object.entries(row).map(([k, v]) => [k, v === null ? "" : String(v)]),
    );
  }
  trail.value = out;
}

/** 一行的名字：键列拼起来；键只有 `id` 时补上第一个像名字的列。 */
const NAME_COLUMNS = ["icao", "ident", "name", "designator", "airway"];
function rowLabel(s: TableSpec, row: Row): string {
  const key = s.key.map((k) => display(row[k])).join(" · ");
  if (s.key.length !== 1 || s.key[0] !== "id") return key;
  const named = NAME_COLUMNS.map((c) => row[c])
    .filter((v) => v !== null && v !== undefined && v !== "")
    .slice(0, 2)
    .map((v) => display(v));
  return named.length ? `${named.join(" ")} #${key}` : `#${key}`;
}

/* --------------------------------------------------------------- 地址栏 */

function syncUrl(push: boolean) {
  const params = new URLSearchParams();
  if (tableName.value) params.set("table", tableName.value);
  for (const [k, v] of Object.entries(filter.value)) if (v) params.set(k, v);
  if (offset.value) params.set("offset", String(offset.value));
  const qs = params.toString();
  const url = window.location.pathname + (qs ? `?${qs}` : "");
  if (push) window.history.pushState(null, "", url);
  else window.history.replaceState(null, "", url);
}

function readUrl() {
  const params = new URLSearchParams(window.location.search);
  const table = params.get("table") ?? "";
  tableName.value = byName.value.has(table) ? table : "";
  const next: Record<string, string> = {};
  for (const [k, v] of params) if (k !== "table" && k !== "offset") next[k] = v;
  filter.value = next;
  offset.value = Math.max(0, Number(params.get("offset")) || 0);
  resetDraft();
  load();
  void buildTrail();
}

onMounted(() => {
  window.addEventListener("popstate", readUrl);
  if (tableName.value) {
    load();
    void buildTrail();
  }
});
onBeforeUnmount(() => window.removeEventListener("popstate", readUrl));

/* --------------------------------------------------------------- 列表 */

const page = ref<RowPage | null>(null);
const loading = ref(false);
const loadError = ref("");
/** 页内反馈：上一次写操作的结果。换表、翻页时清掉。 */
const notice = ref<{ variant: "success" | "danger"; text: string } | null>(
  null,
);
const pickerOpen = ref(false);

function resetDraft() {
  for (const k of Object.keys(draftFilter)) delete draftFilter[k];
  Object.assign(draftFilter, filter.value);
}

let loadRequest = 0;
async function load() {
  const ticket = ++loadRequest;
  page.value = null;
  loadError.value = "";
  if (!tableName.value) return;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(filter.value)) if (v) params.set(k, v);
  params.set("limit", String(PAGE));
  params.set("offset", String(offset.value));
  loading.value = true;
  const result = await api<RowPage>(
    `/api/v1/aip/datasets/${props.datasetId}/tables/${tableName.value}/rows?${params}`,
  );
  // 连点两张表时，先发的那个请求后回来不该盖掉后一张。
  if (ticket !== loadRequest) return;
  loading.value = false;
  if (!result.ok) {
    loadError.value = result.message;
    return;
  }
  page.value = result.data;
}

function go(table: string, next: Record<string, string>) {
  tableName.value = table;
  filter.value = { ...next };
  offset.value = 0;
  notice.value = null;
  pickerOpen.value = false;
  resetDraft();
  syncUrl(true);
  load();
  void buildTrail();
}

function applyFilter() {
  const next: Record<string, string> = {};
  for (const name of filterColumns.value) {
    const v = (draftFilter[name] ?? "").trim();
    if (v) next[name] = v;
  }
  filter.value = next;
  offset.value = 0;
  syncUrl(false);
  load();
  void buildTrail();
}

function clearFilter() {
  for (const k of Object.keys(draftFilter)) draftFilter[k] = "";
  applyFilter();
}

function turnTo(nextOffset: number) {
  offset.value = Math.max(0, nextOffset);
  notice.value = null;
  syncUrl(false);
  load();
}

const range = computed(() => {
  const p = page.value;
  if (!p || !p.total) return null;
  return {
    total: p.total,
    from: p.offset + 1,
    to: p.offset + p.rows.length,
    page: Math.floor(p.offset / PAGE) + 1,
    pages: Math.max(1, Math.ceil(p.total / PAGE)),
  };
});

/* --------------------------------------------------------------- 显示 */

function display(value: RowValue | undefined): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return t("items", { n: value.length });
  if (typeof value === "boolean") return value ? t("true") : t("false");
  return String(value);
}

function keyLabel(row: Row): string {
  return (spec.value?.key ?? []).map((k) => display(row[k])).join(" · ");
}

function keyQuery(row: Row): string {
  const params = new URLSearchParams();
  for (const k of spec.value?.key ?? []) params.set(k, String(row[k] ?? ""));
  return params.toString();
}

const isNumeric = (col: TableColumn) =>
  ["integer", "smallint", "bigint", "double"].includes(col.type);

/* --------------------------------------------------------------- 表单 */

type Mode = "add" | "edit" | "delete";
const mode = ref<Mode | null>(null);
const target = ref<Row | null>(null);
const form = reactive<Record<string, string>>({});
const original = ref<Record<string, string>>({});
const busy = ref(false);
const formError = ref("");
const errorColumn = ref("");

const sheetOpen = computed(() => mode.value === "add" || mode.value === "edit");

/** 一个值在输入框里的样子。布尔用 "true"/"false"，空值用空串。 */
function toInput(col: TableColumn, value: RowValue | undefined): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  if (col.type === "boolean") return value ? "true" : "false";
  return String(value);
}

class InputError extends Error {
  constructor(public column: string) {
    super(column);
  }
}

/** 输入框里的字符串变成 JSON 值。空串是 null（非空文本列是空字符串）。 */
function fromInput(col: TableColumn, raw: string): RowValue {
  const text = raw.trim();
  if (col.type === "text" || col.type === "enum") {
    if (text === "") return col.nullable ? null : "";
    return col.type === "text" ? raw : text;
  }
  if (text === "") return null;
  if (col.type === "boolean") return text === "true";
  if (col.type === "double[]") {
    const parts = text.split(/[\s,]+/).filter(Boolean);
    const nums = parts.map(Number);
    if (nums.some((n) => !Number.isFinite(n))) throw new InputError(col.name);
    return nums;
  }
  const n = Number(text);
  if (!Number.isFinite(n)) throw new InputError(col.name);
  if (col.type !== "double" && !Number.isInteger(n))
    throw new InputError(col.name);
  return n;
}

/** 子表的父列在修改时不可改（can-db 拒绝 PATCH 它）。 */
function isLocked(col: TableColumn): boolean {
  return mode.value === "edit" && spec.value?.parent?.column === col.name;
}

const editableColumns = computed(() =>
  (spec.value?.columns ?? []).filter((c) => !c.identity && !isLocked(c)),
);

function isChanged(col: TableColumn): boolean {
  return (
    mode.value === "edit" &&
    !col.identity &&
    !isLocked(col) &&
    (form[col.name] ?? "") !== (original.value[col.name] ?? "")
  );
}

const changeCount = computed(
  () => (spec.value?.columns ?? []).filter((c) => isChanged(c)).length,
);

function openForm(next: Mode, row: Row | null) {
  mode.value = next;
  target.value = row;
  formError.value = "";
  errorColumn.value = "";
  for (const k of Object.keys(form)) delete form[k];
  const snapshot: Record<string, string> = {};
  for (const col of spec.value?.columns ?? []) {
    snapshot[col.name] = row ? toInput(col, row[col.name]) : "";
  }
  // 新增子表的一行时，把父列预填成正在看的那个父行。
  if (next === "add") {
    for (const [k, v] of Object.entries(filter.value)) {
      if (k in snapshot) snapshot[k] = v;
    }
  }
  Object.assign(form, snapshot);
  original.value = next === "add" ? {} : { ...snapshot };
}

function closeForm() {
  if (!busy.value) mode.value = null;
}

const formTitle = computed(() => {
  const table = tableName.value;
  const key = target.value ? keyLabel(target.value) : "";
  if (mode.value === "add") return t("addTitle", { table });
  if (mode.value === "edit") return t("editTitle", { table, key });
  if (mode.value === "delete") return t("deleteTitle", { table, key });
  return "";
});

/** 从 can-db 的一句错误里认出列名：约束错误带 `column`，其余以列名开头。 */
function columnOf(message: string, column?: string): string {
  // 只认登记表里有的列：一个表单上不存在的列名会让错误既不在顶上也不在任何字段下。
  const name = column || (message.split(/\s/)[0] ?? "");
  return spec.value?.columns.some((c) => c.name === name) ? name : "";
}

/** 标错的那一列滚进视野并拿到焦点 —— 抽屉里二十几个字段，错的那个可能在折线下面。 */
async function focusError() {
  if (!errorColumn.value) return;
  await nextTick();
  const el = document.getElementById(`field-${errorColumn.value}`);
  el?.scrollIntoView({ block: "center" });
  el?.focus();
}

async function submit() {
  const s = spec.value;
  if (!s || !mode.value) return;
  formError.value = "";
  errorColumn.value = "";

  const current = mode.value;
  const base = `/api/v1/aip/datasets/${props.datasetId}/tables/${tableName.value}/rows`;
  let url = base;
  let init: RequestInit;

  if (current === "delete") {
    url = `${base}?${keyQuery(target.value!)}`;
    init = { method: "DELETE" };
  } else {
    const body: Record<string, RowValue> = {};
    try {
      for (const col of editableColumns.value) {
        const raw = form[col.name] ?? "";
        if (current === "add") {
          if (raw.trim() === "") continue;
        } else if (raw === original.value[col.name]) {
          continue;
        }
        body[col.name] = fromInput(col, raw);
      }
    } catch (error) {
      if (error instanceof InputError) {
        errorColumn.value = error.column;
        formError.value = t("invalidNumber", { column: error.column });
        void focusError();
        return;
      }
      throw error;
    }
    if (current === "edit" && Object.keys(body).length === 0) {
      formError.value = t("noChanges");
      return;
    }
    if (current === "edit") url = `${base}?${keyQuery(target.value!)}`;
    init = {
      method: current === "add" ? "POST" : "PATCH",
      body: JSON.stringify(body),
    };
  }

  busy.value = true;
  const result = await api<Row>(url, init);
  busy.value = false;
  if (!result.ok) {
    errorColumn.value = columnOf(result.message, result.column);
    formError.value = result.constraint
      ? `${t("constraint", { constraint: result.constraint })}：${result.message}`
      : result.message;
    void focusError();
    return;
  }
  const table = tableName.value;
  const key =
    current === "add"
      ? result.data
        ? keyLabel(result.data)
        : ""
      : keyLabel(target.value!);
  notice.value = {
    variant: "success",
    text:
      current === "add"
        ? t("created", { table, key })
        : current === "edit"
          ? t("saved", { table, key })
          : t("deleted", { table, key }),
  };
  mode.value = null;
  load();
}
</script>

<template>
  <div class="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:items-start">
    <!-- 左栏：表的树。手机上收成一个按钮，选完自己收起来。 -->
    <aside class="lg:sticky lg:top-6">
      <button
        type="button"
        class="btn btn-secondary w-full justify-between lg:hidden"
        :aria-expanded="pickerOpen"
        aria-controls="editor-table-picker"
        @click="pickerOpen = !pickerOpen"
      >
        <span class="flex min-w-0 items-center gap-2">
          <span class="text-xs font-normal text-muted">{{ t("table") }}</span>
          <span class="truncate font-mono">{{
            tableName || t("pickTable")
          }}</span>
        </span>
        <Icon
          name="chevronDown"
          class="size-4 transition-transform"
          :class="pickerOpen ? 'rotate-180' : ''"
        />
      </button>
      <div
        id="editor-table-picker"
        :class="[
          'card mt-2 p-2 lg:mt-0 lg:block lg:max-h-[calc(100dvh-8rem)] lg:overflow-y-auto',
          pickerOpen ? 'block' : 'hidden',
        ]"
      >
        <TablePicker
          :tables="tables"
          :current="tableName"
          :t="t"
          @pick="(name) => go(name, {})"
        />
      </div>
    </aside>

    <section class="min-w-0 space-y-4">
      <EmptyState
        v-if="!spec"
        class="card"
        icon="squaresPlus"
        :title="t('pickTable')"
        :description="t('pickTableHint')"
      />

      <template v-else>
        <!-- 面包屑：从机场一层层下到这张表。每一段都能点回去。 -->
        <nav :aria-label="t('breadcrumb')">
          <ol
            class="flex flex-wrap items-center gap-x-1.5 gap-y-1 font-mono text-sm"
          >
            <template
              v-for="crumb in trail"
              :key="`${crumb.table}:${crumb.label}`"
            >
              <li>
                <button type="button" class="link" @click="go(crumb.table, {})">
                  {{ crumb.table }}
                </button>
              </li>
              <li class="text-faint" aria-hidden="true">›</li>
              <li>
                <button
                  type="button"
                  class="link text-ink"
                  @click="go(crumb.table, crumb.filter)"
                >
                  {{ crumb.label }}
                </button>
              </li>
              <li class="text-faint" aria-hidden="true">›</li>
            </template>
            <li
              aria-current="page"
              class="text-title-3 font-mono font-semibold text-ink"
            >
              {{ tableName }}
            </li>
          </ol>
        </nav>

        <!-- 工具条：按键列（子表加父列）筛，右边新增。 -->
        <form
          class="card flex flex-wrap items-end gap-3 p-3"
          @submit.prevent="applyFilter"
        >
          <div
            v-for="name in filterColumns"
            :key="name"
            class="min-w-28 flex-1 sm:max-w-44"
          >
            <label
              class="mb-1 block font-mono text-xs text-muted"
              :for="`filter-${name}`"
            >
              {{ name }}
            </label>
            <input
              :id="`filter-${name}`"
              v-model="draftFilter[name]"
              class="input h-9 w-full font-mono"
              autocomplete="off"
              spellcheck="false"
              :placeholder="t('any')"
            />
          </div>
          <div class="flex items-center gap-2">
            <button
              v-if="filterColumns.length"
              type="submit"
              class="btn btn-secondary h-9"
            >
              <Icon name="funnel" class="size-4" />
              {{ t("filter") }}
            </button>
            <button
              v-if="filtered"
              type="button"
              class="btn btn-ghost h-9"
              @click="clearFilter"
            >
              {{ t("clearFilter") }}
            </button>
          </div>
          <button
            type="button"
            class="btn btn-primary ml-auto h-9"
            @click="openForm('add', null)"
          >
            <Icon name="plus" class="size-4" />
            {{ t("add") }}
          </button>
        </form>

        <AlertBox
          v-if="notice"
          :variant="notice.variant"
          dismissible
          @dismiss="notice = null"
        >
          {{ notice.text }}
        </AlertBox>

        <Skeleton v-if="loading" variant="table" :count="8" />

        <AlertBox v-else-if="loadError" variant="danger">
          <div class="flex flex-wrap items-center gap-3">
            <span class="min-w-0 flex-1">{{ loadError }}</span>
            <button
              type="button"
              class="btn btn-secondary h-8 px-2.5 text-xs"
              @click="load"
            >
              {{ t("retry") }}
            </button>
          </div>
        </AlertBox>

        <div v-else-if="page && !page.rows.length" class="card">
          <EmptyState
            v-if="filtered"
            compact
            icon="funnel"
            :title="t('emptyFiltered')"
            :description="t('emptyFilteredHint')"
          >
            <template #action>
              <button
                type="button"
                class="btn btn-secondary"
                @click="clearFilter"
              >
                {{ t("clearFilter") }}
              </button>
            </template>
          </EmptyState>
          <EmptyState
            v-else
            compact
            :title="t('emptyTable')"
            :description="t('emptyTableHint')"
          >
            <template #action>
              <button
                type="button"
                class="btn btn-primary"
                @click="openForm('add', null)"
              >
                {{ t("add") }}
              </button>
            </template>
          </EmptyState>
        </div>

        <template v-else-if="page">
          <div
            class="scroll-shadow-x overflow-x-auto"
            style="--scroll-shadow-bg: var(--surface)"
          >
            <table class="data-table w-full text-sm">
              <thead>
                <tr>
                  <th class="w-px">
                    <span class="sr-only">{{ t("actions") }}</span>
                  </th>
                  <th
                    v-for="col in spec.columns"
                    :key="col.name"
                    class="font-mono whitespace-nowrap"
                    :class="isNumeric(col) ? 'text-right' : ''"
                    :title="col.type"
                  >
                    <span class="inline-flex items-center gap-1">
                      <Icon
                        v-if="spec.key.includes(col.name)"
                        name="key"
                        class="size-3 text-can"
                        :label="t('keyColumn')"
                      />
                      {{ col.name }}
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in page.rows" :key="keyQuery(row)">
                  <td :data-label="t('actions')" class="w-px">
                    <div class="flex items-center gap-0.5">
                      <button
                        type="button"
                        class="icon-button size-8"
                        :aria-label="`${t('editRow')} ${keyLabel(row)}`"
                        :title="t('editRow')"
                        @click="openForm('edit', row)"
                      >
                        <Icon name="pencilSquare" class="size-4" />
                      </button>
                      <Popover
                        v-if="relationsOf(row).length"
                        placement="bottom-start"
                        width="15rem"
                        :label="t('childTables')"
                      >
                        <template #trigger="{ toggle, open }">
                          <button
                            type="button"
                            class="icon-button size-8"
                            :aria-label="`${t('childTables')} ${keyLabel(row)}`"
                            :title="t('childTables')"
                            :aria-expanded="open"
                            aria-haspopup="menu"
                            @click="toggle"
                          >
                            <Icon name="arrowRight" class="size-4" />
                          </button>
                        </template>
                        <template #default="{ close }">
                          <p class="px-2.5 pt-1.5 pb-1 text-xs text-faint">
                            {{ t("childTablesOf", { key: keyLabel(row) }) }}
                          </p>
                          <ul role="menu" class="space-y-0.5">
                            <li
                              v-for="rel in relationsOf(row)"
                              :key="rel.table"
                              role="none"
                            >
                              <button
                                type="button"
                                role="menuitem"
                                class="flex w-full items-center justify-between gap-2 rounded-control px-2.5 py-1.5 text-left font-mono text-sm text-ink transition-colors hover:bg-surface-raised focus-visible:bg-surface-raised focus-visible:outline-none"
                                @click="
                                  close();
                                  go(rel.table, rel.filter);
                                "
                              >
                                {{ rel.table }}
                                <Icon
                                  name="chevronRight"
                                  class="size-4 text-faint"
                                />
                              </button>
                            </li>
                          </ul>
                        </template>
                      </Popover>
                      <button
                        type="button"
                        class="icon-button size-8 hover:text-danger"
                        :aria-label="`${t('deleteRow')} ${keyLabel(row)}`"
                        :title="t('deleteRow')"
                        @click="openForm('delete', row)"
                      >
                        <Icon name="xCircle" class="size-4" />
                      </button>
                    </div>
                  </td>
                  <td
                    v-for="col in spec.columns"
                    :key="col.name"
                    :data-label="col.name"
                    :class="[
                      isNumeric(col) ? 'tnum text-right' : '',
                      spec.key.includes(col.name) ? 'font-mono text-ink' : '',
                      'max-w-64 truncate',
                    ]"
                    :title="display(row[col.name])"
                  >
                    <span
                      v-if="
                        row[col.name] === null || row[col.name] === undefined
                      "
                      class="text-faint"
                      >—</span
                    >
                    <template v-else>{{ display(row[col.name]) }}</template>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          <div
            v-if="range"
            class="tnum flex flex-wrap items-center gap-2 text-sm text-muted"
          >
            <span class="mr-auto">
              {{ t(filtered ? "totalFiltered" : "total", range) }}
            </span>
            <span class="text-xs text-faint">{{
              t("pageOf", { page: range.page, pages: range.pages })
            }}</span>
            <div class="flex items-center gap-1">
              <button
                type="button"
                class="icon-button size-8"
                :aria-label="t('first')"
                :disabled="offset === 0"
                @click="turnTo(0)"
              >
                <Icon name="chevronDoubleLeft" class="size-4" />
              </button>
              <button
                type="button"
                class="btn btn-secondary h-8 px-2.5 text-xs"
                :disabled="offset === 0"
                @click="turnTo(offset - PAGE)"
              >
                <Icon name="chevronLeft" class="size-4" />
                {{ t("prev") }}
              </button>
              <button
                type="button"
                class="btn btn-secondary h-8 px-2.5 text-xs"
                :disabled="range.to >= range.total"
                @click="turnTo(offset + PAGE)"
              >
                {{ t("next") }}
                <Icon name="chevronRight" class="size-4" />
              </button>
              <button
                type="button"
                class="icon-button size-8"
                :aria-label="t('last')"
                :disabled="range.to >= range.total"
                @click="turnTo((range.pages - 1) * PAGE)"
              >
                <Icon name="chevronDoubleRight" class="size-4" />
              </button>
            </div>
          </div>
        </template>
      </template>
    </section>

    <!-- 新增 / 修改：右侧抽屉。 -->
    <Drawer
      :open="sheetOpen"
      side="right"
      width="34rem"
      :title="formTitle"
      :dismissible="!busy"
      @update:open="(v: boolean) => (v ? null : closeForm())"
    >
      <form id="row-form" class="space-y-4" @submit.prevent="submit">
        <p v-if="mode === 'add' && filtered" class="text-xs text-faint">
          {{ t("prefilledHint") }}
        </p>
        <AlertBox v-if="formError && !errorColumn" variant="danger">
          {{ formError }}
        </AlertBox>
        <div class="grid gap-x-4 gap-y-4 sm:grid-cols-2">
          <RowField
            v-for="col in spec?.columns ?? []"
            :key="col.name"
            :model-value="form[col.name] ?? ''"
            @update:model-value="(v: string) => (form[col.name] = v)"
            :class="col.type === 'double[]' ? 'sm:col-span-2' : ''"
            :col="col"
            :mode="mode === 'edit' ? 'edit' : 'add'"
            :is-key="spec?.key.includes(col.name) ?? false"
            :locked="isLocked(col)"
            :changed="isChanged(col)"
            :error="errorColumn === col.name ? formError : ''"
            :t="t"
          />
        </div>
      </form>

      <template #footer>
        <div class="flex items-center gap-2">
          <span
            v-if="mode === 'edit'"
            class="tnum mr-auto text-xs text-faint"
            role="status"
          >
            {{ t("changes", { n: changeCount }) }}
          </span>
          <button
            type="button"
            class="btn btn-secondary"
            :class="mode === 'edit' ? '' : 'ml-auto'"
            :disabled="busy"
            @click="closeForm"
          >
            {{ t("cancel") }}
          </button>
          <button
            type="submit"
            form="row-form"
            class="btn btn-primary"
            :disabled="busy || (mode === 'edit' && changeCount === 0)"
          >
            {{ busy ? t("working") : mode === "add" ? t("create") : t("save") }}
          </button>
        </div>
      </template>
    </Drawer>

    <!-- 删除：页内确认框。 -->
    <Dialog
      :open="mode === 'delete'"
      :title="formTitle"
      :description="t('deleteHint')"
      :dismissible="!busy"
      size="sm"
      @update:open="(v: boolean) => (v ? null : closeForm())"
    >
      <form id="row-delete" @submit.prevent="submit">
        <AlertBox v-if="formError" variant="danger">{{ formError }}</AlertBox>
      </form>
      <template #footer>
        <button
          type="button"
          class="btn btn-secondary"
          :disabled="busy"
          @click="closeForm"
        >
          {{ t("cancel") }}
        </button>
        <button
          type="submit"
          form="row-delete"
          class="btn btn-danger"
          :disabled="busy"
        >
          {{ busy ? t("working") : t("confirmDelete") }}
        </button>
      </template>
    </Dialog>
  </div>
</template>
