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
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from "vue";
import { Dialog } from "@jianyuelab-org/can-ui";
import { createTranslator } from "@/lib/i18n";
import {
  api,
  type Row,
  type RowPage,
  type RowValue,
  type TableColumn,
  type TableSpec,
} from "@/lib/canDb";

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

/** 子表按父列筛着的时候，给一条回到父行的路。 */
const parentLink = computed<Relation | null>(() => {
  const s = spec.value;
  if (!s?.parent) return null;
  const value = filter.value[s.parent.column];
  if (!value) return null;
  return { table: s.parent.table, filter: { id: value } };
});

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
}

onMounted(() => {
  window.addEventListener("popstate", readUrl);
  if (tableName.value) load();
});
onBeforeUnmount(() => window.removeEventListener("popstate", readUrl));

/* --------------------------------------------------------------- 列表 */

const page = ref<RowPage | null>(null);
const loading = ref(false);
const loadError = ref("");

function resetDraft() {
  for (const k of Object.keys(draftFilter)) delete draftFilter[k];
  Object.assign(draftFilter, filter.value);
}

async function load() {
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
  resetDraft();
  syncUrl(true);
  load();
}

function onPickTable(event: Event) {
  go((event.target as HTMLSelectElement).value, {});
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
}

function clearFilter() {
  for (const k of Object.keys(draftFilter)) draftFilter[k] = "";
  applyFilter();
}

function turn(delta: number) {
  offset.value = Math.max(0, offset.value + delta * PAGE);
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
  if (column) return column;
  const first = message.split(/\s/)[0] ?? "";
  return spec.value?.columns.some((c) => c.name === first) ? first : "";
}

async function submit() {
  const s = spec.value;
  if (!s || !mode.value) return;
  formError.value = "";
  errorColumn.value = "";

  const base = `/api/v1/aip/datasets/${props.datasetId}/tables/${tableName.value}/rows`;
  let url = base;
  let init: RequestInit;

  if (mode.value === "delete") {
    url = `${base}?${keyQuery(target.value!)}`;
    init = { method: "DELETE" };
  } else {
    const body: Record<string, RowValue> = {};
    try {
      for (const col of editableColumns.value) {
        const raw = form[col.name] ?? "";
        if (mode.value === "add") {
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
        return;
      }
      throw error;
    }
    if (mode.value === "edit" && Object.keys(body).length === 0) {
      formError.value = t("noChanges");
      return;
    }
    if (mode.value === "edit") url = `${base}?${keyQuery(target.value!)}`;
    init = {
      method: mode.value === "add" ? "POST" : "PATCH",
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
    return;
  }
  mode.value = null;
  load();
}

function fieldId(name: string) {
  return `field-${name}`;
}
</script>

<template>
  <div>
    <div class="mb-4 flex flex-wrap items-end gap-3">
      <div>
        <label class="mb-1 block text-xs text-muted" for="table-picker">{{
          t("table")
        }}</label>
        <select
          id="table-picker"
          :value="tableName"
          class="input w-56 font-mono"
          @change="onPickTable"
        >
          <option value="">{{ t("pickTable") }}</option>
          <option v-for="s in tables" :key="s.name" :value="s.name">
            {{ s.name }}
          </option>
        </select>
      </div>

      <form
        v-if="spec && filterColumns.length"
        class="flex flex-wrap items-end gap-3"
        @submit.prevent="applyFilter"
      >
        <div v-for="name in filterColumns" :key="name">
          <label class="mb-1 block text-xs text-muted" :for="`filter-${name}`">
            {{ name }}
          </label>
          <input
            :id="`filter-${name}`"
            v-model="draftFilter[name]"
            class="input w-32 font-mono"
            autocomplete="off"
          />
        </div>
        <button type="submit" class="btn btn-secondary">
          {{ t("filter") }}
        </button>
        <button
          v-if="Object.keys(filter).length"
          type="button"
          class="btn btn-ghost"
          @click="clearFilter"
        >
          {{ t("clearFilter") }}
        </button>
      </form>

      <button
        v-if="spec"
        type="button"
        class="btn btn-primary ml-auto"
        @click="openForm('add', null)"
      >
        {{ t("add") }}
      </button>
    </div>

    <p v-if="parentLink" class="mb-3 text-sm">
      <button
        type="button"
        class="link"
        @click="go(parentLink.table, parentLink.filter)"
      >
        {{ t("upTo", { table: parentLink.table }) }}
      </button>
      <span class="ml-3 text-muted">{{
        t("parentOf", {
          table: parentLink.table,
          key: parentLink.filter.id ?? "",
          child: tableName,
        })
      }}</span>
    </p>

    <p v-if="loading" class="text-muted">…</p>
    <p v-else-if="loadError" class="badge badge-danger">{{ loadError }}</p>
    <p
      v-else-if="page && !page.rows.length"
      class="card p-10 text-center text-muted"
    >
      {{ t("empty") }}
    </p>

    <template v-else-if="page && spec">
      <div
        class="scroll-shadow-x overflow-x-auto"
        style="--scroll-shadow-bg: var(--surface)"
      >
        <table class="data-table w-full text-sm">
          <thead>
            <tr>
              <th v-for="col in spec.columns" :key="col.name" class="font-mono">
                {{ col.name }}
              </th>
              <th>{{ t("actions") }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in page.rows" :key="keyQuery(row)">
              <td
                v-for="col in spec.columns"
                :key="col.name"
                :data-label="col.name"
                :class="[
                  isNumeric(col) ? 'tnum' : '',
                  spec.key.includes(col.name) ? 'font-mono text-ink' : '',
                  'max-w-64 truncate',
                ]"
                :title="display(row[col.name])"
              >
                <span
                  v-if="row[col.name] === null || row[col.name] === undefined"
                  class="text-faint"
                  >—</span
                >
                <template v-else>{{ display(row[col.name]) }}</template>
              </td>
              <td :data-label="t('actions')">
                <div
                  class="flex flex-wrap items-center gap-x-3 gap-y-1 whitespace-nowrap"
                >
                  <button
                    type="button"
                    class="link"
                    @click="openForm('edit', row)"
                  >
                    {{ t("editRow") }}
                  </button>
                  <button
                    type="button"
                    class="link text-danger"
                    @click="openForm('delete', row)"
                  >
                    {{ t("deleteRow") }}
                  </button>
                  <template
                    v-if="
                      relationsOf(row).length && relationsOf(row).length <= 3
                    "
                  >
                    <button
                      v-for="rel in relationsOf(row)"
                      :key="rel.table"
                      type="button"
                      class="link"
                      @click="go(rel.table, rel.filter)"
                    >
                      {{ t("children", { table: rel.table }) }}
                    </button>
                  </template>
                  <select
                    v-else-if="relationsOf(row).length"
                    class="input h-8 w-40 py-0 font-mono text-xs"
                    :aria-label="t('table')"
                    @change="
                      (e) => {
                        const rel = relationsOf(row).find(
                          (r) =>
                            r.table === (e.target as HTMLSelectElement).value,
                        );
                        if (rel) go(rel.table, rel.filter);
                      }
                    "
                  >
                    <option value="">{{ t("pickTable") }}</option>
                    <option
                      v-for="rel in relationsOf(row)"
                      :key="rel.table"
                      :value="rel.table"
                    >
                      {{ rel.table }}
                    </option>
                  </select>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div
        v-if="range"
        class="tnum mt-3 flex flex-wrap items-center gap-3 text-sm text-muted"
      >
        <span>{{ t("total", range) }}</span>
        <button
          type="button"
          class="btn btn-secondary ml-auto"
          :disabled="offset === 0"
          @click="turn(-1)"
        >
          {{ t("prev") }}
        </button>
        <button
          type="button"
          class="btn btn-secondary"
          :disabled="range.to >= range.total"
          @click="turn(1)"
        >
          {{ t("next") }}
        </button>
      </div>
    </template>

    <Dialog
      :open="mode !== null"
      :title="formTitle"
      :description="mode === 'delete' ? t('deleteHint') : undefined"
      :dismissible="!busy"
      :size="mode === 'delete' ? 'sm' : 'lg'"
      @update:open="(v: boolean) => (v ? null : closeForm())"
    >
      <form id="row-form" @submit.prevent="submit">
        <div
          v-if="mode === 'add' || mode === 'edit'"
          class="grid gap-x-4 gap-y-3 sm:grid-cols-2"
        >
          <div
            v-for="col in spec?.columns ?? []"
            :key="col.name"
            :class="col.type === 'double[]' ? 'sm:col-span-2' : ''"
          >
            <label
              class="mb-1 flex items-baseline justify-between gap-2 text-xs"
              :for="fieldId(col.name)"
            >
              <span class="font-mono text-ink">{{ col.name }}</span>
              <span class="text-faint">
                {{ col.type }}
                <template v-if="col.identity"> · {{ t("generated") }}</template>
                <template
                  v-else-if="!col.nullable && !col.hasDefault && mode === 'add'"
                >
                  · {{ t("required") }}</template
                >
              </span>
            </label>

            <input
              v-if="col.identity || isLocked(col)"
              :id="fieldId(col.name)"
              :value="form[col.name]"
              class="input w-full font-mono"
              disabled
            />
            <select
              v-else-if="col.type === 'boolean'"
              :id="fieldId(col.name)"
              v-model="form[col.name]"
              :class="[
                'input w-full',
                errorColumn === col.name ? 'input-error' : '',
              ]"
            >
              <option value="">
                {{
                  mode === "add" && col.hasDefault
                    ? t("defaultValue")
                    : t("nullValue")
                }}
              </option>
              <option value="true">{{ t("true") }}</option>
              <option value="false">{{ t("false") }}</option>
            </select>
            <select
              v-else-if="col.values?.length"
              :id="fieldId(col.name)"
              v-model="form[col.name]"
              :class="[
                'input w-full font-mono',
                errorColumn === col.name ? 'input-error' : '',
              ]"
            >
              <option value="">
                {{
                  mode === "add" && col.hasDefault
                    ? t("defaultValue")
                    : t("nullValue")
                }}
              </option>
              <option v-for="v in col.values" :key="v" :value="v">
                {{ v }}
              </option>
            </select>
            <textarea
              v-else-if="col.type === 'double[]'"
              :id="fieldId(col.name)"
              v-model="form[col.name]"
              rows="3"
              :placeholder="t('arrayHint')"
              :class="[
                'input w-full font-mono text-xs',
                errorColumn === col.name ? 'input-error' : '',
              ]"
            />
            <input
              v-else
              :id="fieldId(col.name)"
              v-model="form[col.name]"
              :inputmode="isNumeric(col) ? 'decimal' : undefined"
              :placeholder="
                mode === 'add' && col.hasDefault ? t('defaultValue') : undefined
              "
              :required="mode === 'add' && !col.nullable && !col.hasDefault"
              autocomplete="off"
              :class="[
                'input w-full',
                spec?.key.includes(col.name) || isNumeric(col)
                  ? 'font-mono'
                  : '',
                errorColumn === col.name ? 'input-error' : '',
              ]"
            />
          </div>
        </div>

        <p
          v-if="formError"
          class="text-sm text-danger"
          :class="mode === 'delete' ? '' : 'mt-4'"
          role="alert"
        >
          {{ formError }}
        </p>
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
          form="row-form"
          :class="['btn', mode === 'delete' ? 'btn-danger' : 'btn-primary']"
          :disabled="busy"
        >
          {{
            busy
              ? t("working")
              : mode === "delete"
                ? t("confirmDelete")
                : mode === "add"
                  ? t("create")
                  : t("save")
          }}
        </button>
      </template>
    </Dialog>
  </div>
</template>
